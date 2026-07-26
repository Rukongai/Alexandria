from __future__ import annotations

import argparse
import asyncio
import getpass
import logging
import os
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

from .alexandria import AlexandriaClient
from .codex_cleanup import (
    DEFAULT_CLEANUP_TIMEOUT,
    CleanupExecutionError,
    CleanupReceipt,
    CodexCleanupRunner,
    find_cleanup_skill,
    validate_cleanup_receipt,
)
from .folder_metadata import read_metadata
from .folder_upload import FolderUploader, describe_staging
from .grouping import build_bundles
from .importer import ChannelImporter, describe_plan
from .models import MediaRef
from .parallel_download import DEFAULT_CONNECTIONS, MAX_CONNECTIONS
from .progress import (
    ProgressReporter,
    format_bytes,
    guarded_model,
    guarded_reporter,
    reporter_from_args,
)
from .staging import BundleStager, bundle_key
from .telegram_source import TelegramSource
from .tracker import ImportTracker, StagedBundle

log = logging.getLogger(__name__)


def _data_dir() -> Path:
    if root := os.getenv("XDG_DATA_HOME"):
        return Path(root) / "alexandria-telegram-importer"
    return Path.home() / ".local" / "share" / "alexandria-telegram-importer"


def _concurrency(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(
            f"concurrency must be an integer, got {value!r}"
        ) from error
    if parsed < 1:
        raise argparse.ArgumentTypeError("concurrency must be at least 1")
    return parsed


def _positive(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(
            f"count must be an integer, got {value!r}"
        ) from error
    if parsed < 1:
        raise argparse.ArgumentTypeError("count must be at least 1")
    return parsed


def _download_connections(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(
            f"download connections must be an integer, got {value!r}"
        ) from error
    if not 1 <= parsed <= MAX_CONNECTIONS:
        raise argparse.ArgumentTypeError(
            f"download connections must be between 1 and {MAX_CONNECTIONS}"
        )
    return parsed


def _flag_env(name: str) -> bool:
    return os.getenv(name, "").strip().lower() not in {"", "0", "false", "no"}


def _channel(value: str | None) -> str | int | None:
    if value is None or not value.strip():
        return None
    stripped = value.strip()
    return int(stripped) if stripped.lstrip("-").isdigit() else stripped


def parser() -> argparse.ArgumentParser:
    default_dir = _data_dir()
    result = argparse.ArgumentParser(
        description="Import a Telegram channel's model media into Alexandria",
    )
    result.add_argument("--channel", default=os.getenv("TELEGRAM_CHANNEL"))
    result.add_argument(
        "--alexandria-url", default=os.getenv("ALEXANDRIA_URL", "http://localhost:3000")
    )
    result.add_argument(
        "--library-id", default=os.getenv("ALEXANDRIA_LIBRARY_ID") or None
    )
    result.add_argument(
        "--allow-insecure-http",
        action="store_true",
        help="Allow plaintext HTTP to a non-loopback Alexandria host",
    )
    result.add_argument(
        "--session",
        type=Path,
        default=Path(os.getenv("TELEGRAM_SESSION_PATH", default_dir / "telegram")),
    )
    result.add_argument(
        "--state",
        type=Path,
        default=Path(
            os.getenv("TELEGRAM_IMPORT_STATE_PATH", default_dir / "state.sqlite3")
        ),
    )
    result.add_argument("--from-message-id", type=int, default=0)
    result.add_argument("--poll-interval", type=float, default=2.0)
    result.add_argument(
        "--concurrency",
        type=_concurrency,
        default=os.getenv("TELEGRAM_IMPORT_CONCURRENCY", "1"),
        help=(
            "Number of Telegram models to import at the same time. Higher values "
            "trade disk use and Telegram rate-limit risk for throughput (default 1)"
        ),
    )
    result.add_argument(
        "--download-connections",
        type=_download_connections,
        default=os.getenv("TELEGRAM_DOWNLOAD_CONNECTIONS", str(DEFAULT_CONNECTIONS)),
        help=(
            "Connections used to download one file's chunks at the same time. "
            f"Telegram serves one chunk per round trip per connection, so this "
            f"multiplies download speed directly (1 disables, default "
            f"{DEFAULT_CONNECTIONS}, maximum {MAX_CONNECTIONS})"
        ),
    )
    result.add_argument(
        "--dry-run",
        action="store_true",
        help="Show grouping without downloading or uploading",
    )
    result.add_argument(
        "--no-progress",
        action="store_true",
        default=_flag_env("TELEGRAM_IMPORT_NO_PROGRESS"),
        help=("Disable the progress display entirely and log as earlier versions did"),
    )
    result.add_argument("--verbose", action="store_true")
    result.add_argument(
        "--staging-dir",
        type=Path,
        default=(
            Path(staging) if (staging := os.getenv("TELEGRAM_STAGING_DIR")) else None
        ),
        help=(
            "Directory holding staged model folders. Required by --download-only, "
            "--upload-only, and --stage"
        ),
    )
    staging_mode = result.add_mutually_exclusive_group()
    staging_mode.add_argument(
        "--download-only",
        type=_positive,
        metavar="N",
        help="Stage up to N new Telegram bundles as folders, then exit",
    )
    staging_mode.add_argument(
        "--upload-only",
        action="store_true",
        help="Upload every model folder already in --staging-dir, then exit",
    )
    staging_mode.add_argument(
        "--stage",
        type=_positive,
        metavar="N",
        help=(
            "Stage up to N new bundles, reorganize them manually or with Codex, "
            "then upload"
        ),
    )
    result.add_argument(
        "--cleanup",
        choices=("manual", "codex"),
        default=os.getenv("TELEGRAM_STAGE_CLEANUP", "manual"),
        help="How --stage reorganizes downloaded folders before upload (default manual)",
    )
    result.add_argument(
        "--cleanup-reference",
        type=Path,
        default=(
            Path(reference)
            if (reference := os.getenv("TELEGRAM_CODEX_CLEANUP_REFERENCE"))
            else None
        ),
        help="Completed reference model folder whose metadata shape Codex must follow",
    )
    result.add_argument(
        "--cleanup-skill",
        type=Path,
        default=(
            Path(skill)
            if (skill := os.getenv("TELEGRAM_CODEX_CLEANUP_SKILL"))
            else None
        ),
        help="Override the repository-owned Codex cleanup SKILL.md",
    )
    result.add_argument(
        "--cleanup-concurrency",
        type=_concurrency,
        default=os.getenv("TELEGRAM_CODEX_CLEANUP_CONCURRENCY", "1"),
        help="Number of independent staged bundles Codex cleans at once (default 1)",
    )
    result.add_argument(
        "--cleanup-timeout",
        type=_positive,
        default=os.getenv(
            "TELEGRAM_CODEX_CLEANUP_TIMEOUT",
            str(DEFAULT_CLEANUP_TIMEOUT),
        ),
        metavar="SECONDS",
        help="Maximum time allowed for one Codex cleanup (default 3600)",
    )
    result.add_argument(
        "--codex-command",
        default=os.getenv("TELEGRAM_CODEX_COMMAND", "codex"),
        help="Codex executable used by --cleanup codex (default codex)",
    )
    return result


def validate_staging_args(args: argparse.Namespace) -> None:
    selected = (
        args.download_only is not None or args.upload_only or args.stage is not None
    )
    if selected and args.staging_dir is None:
        raise SystemExit(
            "--staging-dir is required by --download-only, --upload-only, and --stage"
        )
    if args.staging_dir is not None and not selected:
        raise SystemExit(
            "--staging-dir requires one of --download-only, --upload-only, or --stage"
        )
    if args.cleanup == "codex" and args.stage is None:
        raise SystemExit("--cleanup codex requires --stage")
    if args.cleanup == "codex" and args.cleanup_reference is None:
        raise SystemExit("--cleanup codex requires --cleanup-reference")
    cleanup_options_used = (
        args.cleanup_reference is not None or args.cleanup_skill is not None
    )
    if cleanup_options_used and args.cleanup != "codex":
        raise SystemExit(
            "--cleanup-reference and --cleanup-skill require --cleanup codex"
        )


def confirm_upload(summary: str) -> bool:
    """Pause between the phases. A non-interactive stdin quits rather than hangs."""
    print(summary)
    print(
        "Reorganize the folders now — split releases, compress, rename, "
        "edit metadata.json."
    )
    print("Press Enter to upload, or q then Enter to quit without uploading.")
    line = sys.stdin.readline()
    if not line:
        print("No input available; leaving the staged folders in place.")
        return False
    return line.strip().lower() != "q"


@dataclass(frozen=True, slots=True)
class StagingResult:
    items: tuple[StagedBundle, ...]
    failed_keys: tuple[str, ...]
    staged_bytes: int

    @property
    def staged(self) -> int:
        return len(self.items)

    @property
    def failed(self) -> int:
        return len(self.failed_keys)


@dataclass(frozen=True, slots=True)
class ReadyBundle:
    item: StagedBundle
    paths: tuple[Path, ...]

    @property
    def bundle_key(self) -> str:
        return self.item.bundle_key


@dataclass(frozen=True, slots=True)
class ReadyRevalidation:
    paths: tuple[Path, ...]
    errors: tuple[str, ...]

    @property
    def ready(self) -> bool:
        return not self.errors


@dataclass(frozen=True, slots=True)
class CleanupBatchResult:
    ready_bundles: tuple[ReadyBundle, ...]
    outcomes: dict[str, int]

    @property
    def ready_paths(self) -> tuple[Path, ...]:
        return tuple(path for bundle in self.ready_bundles for path in bundle.paths)

    @property
    def failed(self) -> int:
        return self.outcomes.get("needs_review", 0) + self.outcomes.get(
            "cleanup_failed",
            0,
        )


def revalidate_ready_bundle(
    bundle: ReadyBundle,
    *,
    staging_dir: Path,
    reference_folder: Path,
) -> ReadyRevalidation:
    """Revalidate persisted Codex output immediately before upload."""
    report = bundle.item.cleanup_report
    if not isinstance(report, dict):
        return ReadyRevalidation((), ("Persisted cleanup report is missing",))
    original_metadata = report.get("originalMetadata")
    if not isinstance(original_metadata, dict):
        return ReadyRevalidation((), ("Original staged metadata is missing",))
    input_folder = (staging_dir / bundle.item.folder_name).resolve()
    try:
        receipt = CleanupReceipt.from_payload(report, input_folder=input_folder)
        validation = validate_cleanup_receipt(
            receipt,
            staging_root=staging_dir,
            original_metadata=original_metadata,
            reference_folder=reference_folder,
        )
    except Exception as error:  # noqa: BLE001 - untrusted persisted/Codex data
        return ReadyRevalidation((), (f"Cleanup revalidation failed: {error}",))
    if not validation.ready:
        return ReadyRevalidation((), validation.errors)
    validated_paths = tuple(folder.path.resolve() for folder in validation.folders)
    if {path.resolve() for path in bundle.paths} != set(validated_paths):
        return ReadyRevalidation(
            (),
            ("Persisted output allowlist does not match the validated receipt",),
        )
    return ReadyRevalidation(validated_paths, ())


async def stage_bundles(
    *,
    telegram: TelegramSource,
    tracker: ImportTracker,
    refs: list[MediaRef],
    staging_dir: Path,
    limit: int,
    progress: ProgressReporter,
    concurrency: int = 1,
    exclude_keys: set[str] | None = None,
) -> StagingResult:
    """Stage up to `limit` not-yet-staged bundles.

    Returns the new persisted bundle records plus failures and downloaded bytes.
    `concurrency` bundles are staged at once, matching the direct import path.
    """
    already = tracker.staged_keys(telegram.channel_id) | (exclude_keys or set())
    stager = BundleStager(telegram=telegram, root=staging_dir)
    pending = []
    for bundle in build_bundles(telegram.channel_id, refs):
        if len(pending) >= limit:
            break
        key = bundle_key(telegram.channel_id, bundle)
        if key not in already:
            pending.append((key, bundle))

    staged_items: list[StagedBundle] = []
    failed_keys: list[str] = []
    staged_bytes = 0
    slots = asyncio.Semaphore(concurrency)
    lock = asyncio.Lock()

    async def stage_one(key: str, bundle) -> None:
        nonlocal staged_bytes
        label = bundle.models[0].logical_filename
        async with slots:
            try:
                with guarded_model(progress, label, parts=1) as handle:
                    folder = await stager.stage(bundle, handle)
            # One unreachable Telegram post must not stop the rest of the run.
            except Exception as error:  # noqa: BLE001
                log.error("Failed to stage bundle at %s: %s", label, error)
                async with lock:
                    failed_keys.append(key)
                return
            size = sum(
                path.stat().st_size for path in folder.rglob("*") if path.is_file()
            )
        async with lock:
            staged_items.append(
                tracker.record_staged(
                    bundle_key=key,
                    source_channel_id=telegram.channel_id,
                    folder_name=folder.name,
                    model_message_ids=tuple(
                        part.message_id for unit in bundle.models for part in unit.parts
                    ),
                ),
            )
            staged_bytes += size
            _report_staging(progress, len(staged_items), len(pending), len(failed_keys))

    with guarded_reporter(progress):
        _report_staging(progress, 0, len(pending), 0)
        results = await asyncio.gather(
            *(stage_one(key, bundle) for key, bundle in pending),
            return_exceptions=True,
        )
    for result in results:
        if isinstance(result, BaseException):
            raise result
    return StagingResult(
        items=tuple(sorted(staged_items, key=lambda item: item.folder_name)),
        failed_keys=tuple(sorted(failed_keys)),
        staged_bytes=staged_bytes,
    )


async def cleanup_staged_bundles(
    *,
    items: tuple[StagedBundle, ...],
    staging_dir: Path,
    tracker: ImportTracker,
    runner: CodexCleanupRunner,
    work_root: Path,
    concurrency: int = 1,
) -> CleanupBatchResult:
    """Run isolated Codex cleanups and validate every claimed ready folder."""
    outcomes: Counter[str] = Counter()
    ready_bundles: list[ReadyBundle] = []
    slots = asyncio.Semaphore(concurrency)
    lock = asyncio.Lock()

    async def clean(item: StagedBundle) -> None:
        input_folder = (staging_dir / item.folder_name).resolve()
        persisted_original = (
            item.cleanup_report.get("originalMetadata")
            if isinstance(item.cleanup_report, dict)
            else None
        )
        original_metadata = (
            persisted_original
            if isinstance(persisted_original, dict)
            else read_metadata(input_folder)
        )
        if original_metadata is None:
            report = {"status": "failed", "error": "Original metadata.json is missing"}
            tracker.update_staged_cleanup(
                item.bundle_key,
                status="cleanup_failed",
                report=report,
            )
            async with lock:
                outcomes["cleanup_failed"] += 1
            return

        tracker.update_staged_cleanup(
            item.bundle_key,
            status="cleaning",
            report={"originalMetadata": original_metadata},
        )
        try:
            async with slots:
                receipt = await runner.run(
                    bundle_key=item.bundle_key,
                    input_folder=input_folder,
                    work_root=work_root,
                )
        except CleanupExecutionError as error:
            log.error("Codex cleanup failed for %s: %s", item.folder_name, error)
            tracker.update_staged_cleanup(
                item.bundle_key,
                status="cleanup_failed",
                report={
                    "status": "failed",
                    "error": str(error),
                    "originalMetadata": original_metadata,
                },
            )
            async with lock:
                outcomes["cleanup_failed"] += 1
            return

        report = {
            **receipt.as_payload(),
            "originalMetadata": original_metadata,
        }
        relative_outputs = tuple(
            str(path.relative_to(staging_dir.resolve()))
            for path in receipt.output_folders
            if path == staging_dir.resolve()
            or path.is_relative_to(staging_dir.resolve())
        )
        if receipt.status != "ready":
            status = (
                "needs_review" if receipt.status == "needs_review" else "cleanup_failed"
            )
            tracker.update_staged_cleanup(
                item.bundle_key,
                status=status,
                output_folders=relative_outputs,
                report=report,
            )
            log.warning(
                "Codex left %s in %s: %s", item.folder_name, status, receipt.summary
            )
            async with lock:
                outcomes[status] += 1
            return

        try:
            validation = await asyncio.to_thread(
                validate_cleanup_receipt,
                receipt,
                staging_root=staging_dir,
                original_metadata=original_metadata,
                reference_folder=runner.reference_folder,
            )
        except Exception as error:
            report["validationErrors"] = [f"Unexpected validation error: {error}"]
            tracker.update_staged_cleanup(
                item.bundle_key,
                status="cleanup_failed",
                output_folders=relative_outputs,
                report=report,
            )
            log.exception("Cleanup validation crashed for %s", item.folder_name)
            async with lock:
                outcomes["cleanup_failed"] += 1
            return
        if not validation.ready:
            report["validationErrors"] = list(validation.errors)
            tracker.update_staged_cleanup(
                item.bundle_key,
                status="cleanup_failed",
                output_folders=relative_outputs,
                report=report,
            )
            log.error(
                "Cleanup validation failed for %s: %s",
                item.folder_name,
                "; ".join(validation.errors),
            )
            async with lock:
                outcomes["cleanup_failed"] += 1
            return

        validated_paths = tuple(folder.path.resolve() for folder in validation.folders)
        ready_item = tracker.update_staged_cleanup(
            item.bundle_key,
            status="ready",
            output_folders=tuple(
                str(path.relative_to(staging_dir.resolve())) for path in validated_paths
            ),
            report=report,
        )
        log.info("Codex prepared %s: %s", item.folder_name, receipt.summary)
        async with lock:
            ready_bundles.append(ReadyBundle(ready_item, validated_paths))
            outcomes["ready"] += 1

    await asyncio.gather(*(clean(item) for item in items))
    return CleanupBatchResult(
        ready_bundles=tuple(sorted(ready_bundles, key=lambda item: item.bundle_key)),
        outcomes=dict(outcomes),
    )


def _report_staging(
    progress: ProgressReporter, staged: int, total: int, failed: int
) -> None:
    try:
        progress.totals(staged, total, {"staged": staged, "failed": failed})
    except Exception as error:  # noqa: BLE001 - a display fault is not a staging fault
        log.debug("Progress reporter could not record totals: %s", error)


def _staging_summary(
    staging_dir: Path, staged: int, failed: int, staged_bytes: int
) -> str:
    line = f"{staged} folders staged in {staging_dir} ({format_bytes(staged_bytes)})."
    return line + (f" {failed} bundle(s) failed to stage." if failed else "")


def _upload_summary(outcomes: dict[str, int]) -> str:
    return "Upload state: " + ", ".join(
        f"{status}={count}" for status, count in sorted(outcomes.items())
    )


def _cleanup_summary(outcomes: dict[str, int]) -> str:
    if not outcomes:
        return "Cleanup state: no new folders"
    return "Cleanup state: " + ", ".join(
        f"{status}={count}" for status, count in sorted(outcomes.items())
    )


async def _login(args: argparse.Namespace) -> AlexandriaClient:
    email = os.getenv("ALEXANDRIA_EMAIL") or input("Alexandria email: ").strip()
    password = os.getenv("ALEXANDRIA_PASSWORD") or getpass.getpass(
        "Alexandria password: "
    )
    client = AlexandriaClient(
        args.alexandria_url,
        library_id=args.library_id,
        poll_interval=args.poll_interval,
        allow_insecure_http=args.allow_insecure_http,
    )
    await client.login(email, password)
    return client


async def run_codex_staged_batches(
    *,
    args: argparse.Namespace,
    telegram: TelegramSource,
    tracker: ImportTracker,
    refs: list[MediaRef],
    progress: ProgressReporter,
    work_root: Path,
) -> int:
    """Drain Telegram through stage, Codex cleanup, and scoped upload batches."""
    skill_path = args.cleanup_skill or find_cleanup_skill()
    if skill_path is None:
        raise SystemExit(
            "Repository Codex cleanup skill was not found; use --cleanup-skill",
        )
    runner = CodexCleanupRunner(
        skill_path=skill_path,
        reference_folder=args.cleanup_reference,
        command=args.codex_command,
        timeout_seconds=args.cleanup_timeout,
    )
    try:
        runner.preflight()
    except CleanupExecutionError as error:
        raise SystemExit(str(error)) from error

    excluded_keys: set[str] = set()
    totals: Counter[str] = Counter()
    batch_number = 0
    alexandria: AlexandriaClient | None = None

    async def upload_ready(bundle: ReadyBundle, *, label: str) -> None:
        nonlocal alexandria
        revalidation = await asyncio.to_thread(
            revalidate_ready_bundle,
            bundle,
            staging_dir=args.staging_dir,
            reference_folder=runner.reference_folder,
        )
        if not revalidation.ready:
            report = dict(bundle.item.cleanup_report or {})
            report["preUploadValidationErrors"] = list(revalidation.errors)
            tracker.update_staged_cleanup(
                bundle.bundle_key,
                status="cleanup_failed",
                output_folders=bundle.item.output_folders,
                report=report,
            )
            totals["cleanup_failed"] += 1
            log.error(
                "%s failed pre-upload validation: %s",
                label,
                "; ".join(revalidation.errors),
            )
            return
        if alexandria is None:
            alexandria = await _login(args)
        tracker.update_staged_status(bundle.bundle_key, status="uploading")
        try:
            upload_outcomes = await FolderUploader(
                alexandria=alexandria,
                work_root=work_root,
                concurrency=args.concurrency,
                progress=progress,
            ).run(args.staging_dir, include_paths=revalidation.paths)
        except Exception as error:  # noqa: BLE001 - record the bundle before aborting
            tracker.update_staged_status(bundle.bundle_key, status="upload_failed")
            totals["upload_failed"] += 1
            log.error("Upload failed for %s: %s", label, error)
            return
        print(f"{label}: {_upload_summary(upload_outcomes)}")
        completed = upload_outcomes.get("completed", 0)
        failed = upload_outcomes.get("failed", 0)
        totals["uploaded"] += completed
        totals["upload_failed"] += failed
        tracker.update_staged_status(
            bundle.bundle_key,
            status="uploaded"
            if completed == len(revalidation.paths) and not failed
            else "upload_failed",
        )

    async def clean_and_upload(
        items: tuple[StagedBundle, ...],
        *,
        label: str,
    ) -> None:
        cleanup = await cleanup_staged_bundles(
            items=items,
            staging_dir=args.staging_dir,
            tracker=tracker,
            runner=runner,
            work_root=work_root,
            concurrency=args.cleanup_concurrency,
        )
        print(f"{label}: {_cleanup_summary(cleanup.outcomes)}")
        for status, count in cleanup.outcomes.items():
            totals[status] += count
        for bundle in cleanup.ready_bundles:
            await upload_ready(bundle, label=label)

    try:
        indeterminate_uploads = tracker.staged_by_status(
            telegram.channel_id,
            ("uploading",),
        )
        for item in indeterminate_uploads:
            report = dict(item.cleanup_report or {})
            report["uploadRecovery"] = (
                "A previous process stopped after upload began. Reconcile the "
                "Alexandria session before retrying to avoid a duplicate model."
            )
            tracker.update_staged_cleanup(
                item.bundle_key,
                status="needs_review",
                output_folders=item.output_folders,
                report=report,
            )
            totals["needs_review"] += 1
            log.error(
                "Upload state is indeterminate for %s; manual reconciliation required",
                item.folder_name,
            )

        resumable_uploads = tracker.staged_by_status(
            telegram.channel_id,
            ("ready",),
        )
        for item in resumable_uploads:
            batch_number += 1
            paths = tuple(
                (args.staging_dir / path).resolve() for path in item.output_folders
            )
            print(f"Batch {batch_number}: resuming upload for {item.folder_name}")
            await upload_ready(
                ReadyBundle(item, paths),
                label=f"Batch {batch_number}",
            )

        resumable_cleanups = tracker.staged_by_status(
            telegram.channel_id,
            ("downloaded", "cleaning", "cleanup_failed"),
        )
        for offset in range(0, len(resumable_cleanups), args.stage):
            items = resumable_cleanups[offset : offset + args.stage]
            batch_number += 1
            totals["resumed"] += len(items)
            print(f"Batch {batch_number}: resuming cleanup for {len(items)} folder(s)")
            await clean_and_upload(items, label=f"Batch {batch_number}")

        while True:
            staging = await stage_bundles(
                telegram=telegram,
                tracker=tracker,
                refs=refs,
                staging_dir=args.staging_dir,
                limit=args.stage,
                progress=progress,
                concurrency=args.concurrency,
                exclude_keys=excluded_keys,
            )
            excluded_keys.update(staging.failed_keys)
            totals["stage_failed"] += staging.failed
            if not staging.items and not staging.failed_keys:
                break

            batch_number += 1
            print(
                f"Batch {batch_number}: "
                + _staging_summary(
                    args.staging_dir,
                    staging.staged,
                    staging.failed,
                    staging.staged_bytes,
                ),
            )
            if not staging.items:
                continue
            totals["staged"] += staging.staged
            await clean_and_upload(staging.items, label=f"Batch {batch_number}")
    finally:
        if alexandria is not None:
            await alexandria.close()

    print(
        "Automated staged import: "
        + ", ".join(
            [f"batches={batch_number}"]
            + [f"{status}={count}" for status, count in sorted(totals.items())],
        ),
    )
    failed = any(
        totals.get(status, 0)
        for status in (
            "stage_failed",
            "needs_review",
            "cleanup_failed",
            "upload_failed",
        )
    )
    return 1 if failed else 0


async def run(args: argparse.Namespace) -> int:
    alexandria: AlexandriaClient | None = None
    tracker: ImportTracker | None = None
    progress = reporter_from_args(
        no_progress=args.no_progress,
        dry_run=args.dry_run,
        verbose=args.verbose,
    )
    work_root = args.state.parent / f"{args.state.name}.work"

    # Uploading staged folders touches nothing but the staging directory and
    # Alexandria. It must not need Telegram credentials, open a Telegram
    # session file, or scan the channel — so it returns before any of that.
    if args.upload_only:
        if not args.staging_dir.is_dir():
            raise SystemExit(f"Staging directory {args.staging_dir} does not exist")
        if args.dry_run:
            print(describe_staging(args.staging_dir))
            return 0
        try:
            alexandria = await _login(args)
            outcomes = await FolderUploader(
                alexandria=alexandria,
                work_root=work_root,
                concurrency=args.concurrency,
                progress=progress,
            ).run(args.staging_dir)
            print(_upload_summary(outcomes))
            return 1 if outcomes.get("failed") else 0
        finally:
            if alexandria:
                await alexandria.close()

    api_id_text = os.getenv("TELEGRAM_API_ID") or os.getenv("API_ID")
    api_hash = os.getenv("TELEGRAM_API_HASH") or os.getenv("API_HASH")
    if not api_id_text or not api_hash:
        raise SystemExit("TELEGRAM_API_ID and TELEGRAM_API_HASH are required")
    try:
        api_id = int(api_id_text)
    except ValueError as error:
        raise SystemExit("TELEGRAM_API_ID must be an integer") from error

    telegram = TelegramSource(
        api_id=api_id,
        api_hash=api_hash,
        session_path=args.session,
        phone=os.getenv("TELEGRAM_PHONE") or os.getenv("PHONE") or None,
        download_connections=args.download_connections,
    )

    try:
        await telegram.connect(_channel(args.channel))
        refs = await telegram.collect_media(min_message_id=args.from_message_id)
        if args.dry_run:
            print(describe_plan(telegram.channel_id, refs))
            return 0

        failed_to_stage = 0

        if args.download_only is not None or args.stage is not None:
            tracker = ImportTracker(args.state)
            if args.stage is not None and args.cleanup == "codex":
                return await run_codex_staged_batches(
                    args=args,
                    telegram=telegram,
                    tracker=tracker,
                    refs=refs,
                    progress=progress,
                    work_root=work_root,
                )
            staging = await stage_bundles(
                telegram=telegram,
                tracker=tracker,
                refs=refs,
                staging_dir=args.staging_dir,
                limit=args.download_only or args.stage,
                progress=progress,
                concurrency=args.concurrency,
            )
            summary = _staging_summary(
                args.staging_dir,
                staging.staged,
                staging.failed,
                staging.staged_bytes,
            )
            failed_to_stage = staging.failed
            if args.download_only is not None:
                print(summary)
                return 1 if failed_to_stage else 0
            if args.cleanup == "manual" and not confirm_upload(summary):
                return 1 if failed_to_stage else 0

        if args.stage is not None:
            alexandria = await _login(args)
            outcomes = await FolderUploader(
                alexandria=alexandria,
                work_root=work_root,
                concurrency=args.concurrency,
                progress=progress,
            ).run(args.staging_dir)
            print(_upload_summary(outcomes))
            return 1 if outcomes.get("failed") or failed_to_stage else 0

        alexandria = await _login(args)
        tracker = tracker or ImportTracker(args.state)
        counts = await ChannelImporter(
            telegram=telegram,
            alexandria=alexandria,
            tracker=tracker,
            work_root=work_root,
            concurrency=args.concurrency,
            progress=progress,
        ).run(refs)
        print(
            "Import state: "
            + ", ".join(f"{status}={count}" for status, count in sorted(counts.items()))
        )
        return (
            1 if counts.get("failed", 0) or counts.get("completion_uncertain", 0) else 0
        )
    finally:
        if tracker:
            tracker.close()
        if alexandria:
            await alexandria.close()
        await telegram.close()


def main() -> None:
    load_dotenv()
    args = parser().parse_args()
    validate_staging_args(args)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    raise SystemExit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()
