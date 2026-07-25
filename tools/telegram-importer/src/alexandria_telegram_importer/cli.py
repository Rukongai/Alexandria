from __future__ import annotations

import argparse
import asyncio
import getpass
import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

from .alexandria import AlexandriaClient
from .folder_upload import FolderUploader
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
from .tracker import ImportTracker

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
            "Stage up to N new bundles, pause for reorganization, then upload "
            "whatever is in --staging-dir"
        ),
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


async def stage_bundles(
    *,
    telegram: TelegramSource,
    tracker: ImportTracker,
    refs: list[MediaRef],
    staging_dir: Path,
    limit: int,
    progress: ProgressReporter,
) -> tuple[int, int]:
    """Stage up to `limit` not-yet-staged bundles. Returns (staged, failed)."""
    already = tracker.staged_keys(telegram.channel_id)
    stager = BundleStager(telegram=telegram, root=staging_dir)
    staged = 0
    failed = 0
    with guarded_reporter(progress):
        for bundle in build_bundles(telegram.channel_id, refs):
            if staged >= limit:
                break
            key = bundle_key(telegram.channel_id, bundle)
            if key in already:
                continue
            label = bundle.models[0].logical_filename
            try:
                with guarded_model(progress, label, parts=1) as handle:
                    folder = await stager.stage(bundle, handle)
            # One unreachable Telegram post must not stop the rest of the run.
            except Exception as error:  # noqa: BLE001
                log.error("Failed to stage bundle at %s: %s", label, error)
                failed += 1
                continue
            tracker.record_staged(
                bundle_key=key,
                source_channel_id=telegram.channel_id,
                folder_name=folder.name,
                model_message_ids=tuple(
                    part.message_id for unit in bundle.models for part in unit.parts
                ),
            )
            staged += 1
            progress.totals(staged, limit, {"staged": staged, "failed": failed})
    return staged, failed


def _staging_summary(staging_dir: Path, staged: int, failed: int) -> str:
    total_bytes = sum(
        path.stat().st_size for path in staging_dir.rglob("*") if path.is_file()
    )
    line = f"{staged} folders staged in {staging_dir} ({format_bytes(total_bytes)})."
    return line + (f" {failed} bundle(s) failed to stage." if failed else "")


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


async def run(args: argparse.Namespace) -> int:
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
    alexandria: AlexandriaClient | None = None
    tracker: ImportTracker | None = None
    try:
        await telegram.connect(_channel(args.channel))
        refs = await telegram.collect_media(min_message_id=args.from_message_id)
        if args.dry_run:
            print(describe_plan(telegram.channel_id, refs))
            return 0

        progress = reporter_from_args(
            no_progress=args.no_progress,
            dry_run=args.dry_run,
            verbose=args.verbose,
        )
        work_root = args.state.parent / f"{args.state.name}.work"
        failed_to_stage = 0

        if args.download_only is not None or args.stage is not None:
            tracker = ImportTracker(args.state)
            staged, failed_to_stage = await stage_bundles(
                telegram=telegram,
                tracker=tracker,
                refs=refs,
                staging_dir=args.staging_dir,
                limit=args.download_only or args.stage,
                progress=progress,
            )
            summary = _staging_summary(args.staging_dir, staged, failed_to_stage)
            if args.download_only is not None:
                print(summary)
                return 1 if failed_to_stage else 0
            if not confirm_upload(summary):
                return 1 if failed_to_stage else 0

        if args.upload_only or args.stage is not None:
            alexandria = await _login(args)
            outcomes = await FolderUploader(
                alexandria=alexandria,
                work_root=work_root,
                concurrency=args.concurrency,
                progress=progress,
            ).run(args.staging_dir)
            print(
                "Upload state: "
                + ", ".join(
                    f"{status}={count}" for status, count in sorted(outcomes.items())
                ),
            )
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
