from __future__ import annotations

import asyncio
import hashlib
import logging
import shutil
import tempfile
import zipfile
from collections.abc import Iterable, Iterator
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any

from .alexandria import AlexandriaClient, AlexandriaError, session_filenames
from .concurrency import SignatureGate
from .grouping import (
    ARCHIVE_EXTENSIONS,
    build_bundles,
    model_name_from_filename,
    multipart_part_role,
    safe_filename,
    validate_logical_model,
)
from .models import ImportBundle, LogicalModel, MediaRef
from .telegram_source import TelegramSource
from .tracker import ImportRecord, ImportTracker

log = logging.getLogger(__name__)


class CompletionUncertain(AlexandriaError):
    pass


class DuplicateModelFound(Exception):
    def __init__(self, original: ImportRecord, signature_type: str) -> None:
        super().__init__(f"duplicate of {original.import_key} by {signature_type}")
        self.original = original
        self.signature_type = signature_type


def _upload_prefix(channel_id: int, unit: LogicalModel) -> str:
    return f"tg-{abs(channel_id)}-{unit.key[:12]}-"


def upload_filename(channel_id: int, unit: LogicalModel) -> str:
    prefix = _upload_prefix(channel_id, unit)
    if unit.multipart or unit.logical_filename.lower().endswith(ARCHIVE_EXTENSIONS):
        return prefix + safe_filename(unit.logical_filename, "model.zip")
    return (
        prefix
        + safe_filename(model_name_from_filename(unit.logical_filename), "model")
        + ".zip"
    )


def part_upload_names(channel_id: int, unit: LogicalModel) -> tuple[str, ...]:
    prefix = _upload_prefix(channel_id, unit)
    return tuple(
        prefix + safe_filename(part.filename, f"part-{part.message_id}")
        for part in unit.parts
    )


def attachment_upload_name(ref: MediaRef) -> str:
    return f"telegram-{ref.message_id}-{safe_filename(ref.filename, 'media')}"


def telegram_media_signature(unit: LogicalModel) -> str | None:
    identities = [part.media_identity for part in unit.parts]
    if not identities or any(identity is None for identity in identities):
        return None
    return _model_signature(
        unit,
        (identity for identity in identities if identity is not None),
    )


def content_signature(unit: LogicalModel, hashes: Iterable[str]) -> str:
    hashes = tuple(hashes)
    if not hashes:
        raise ValueError("At least one content hash is required")
    return _model_signature(unit, hashes)


def _model_signature(unit: LogicalModel, values: Iterable[str]) -> str:
    values = tuple(values)
    if len(values) != len(unit.parts):
        raise ValueError("Every model part must have one signature value")
    if not unit.multipart:
        return _signature(values)
    return _signature(
        f"{multipart_part_role(part.filename)}\0{value}"
        for part, value in zip(unit.parts, values, strict=True)
    )


def _signature(values: Iterable[str]) -> str:
    payload = "\n".join(sorted(values))
    return hashlib.sha256(payload.encode()).hexdigest()


def _hash_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while chunk := handle.read(8 * 1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def build_description(
    source: TelegramSource,
    unit: LogicalModel,
    attachments: tuple[MediaRef, ...],
    related: tuple[LogicalModel, ...],
) -> str:
    sections: list[str] = []
    seen_captions: set[str] = set()
    for ref in (*attachments, *unit.parts):
        if ref.caption and ref.caption not in seen_captions:
            sections.append(ref.caption)
            seen_captions.add(ref.caption)

    if related:
        related_lines = [
            f"- {item.logical_filename} (Telegram message{'' if len(item.parts) == 1 else 's'} "
            f"{', '.join(str(part.message_id) for part in item.parts)})"
            for item in related
        ]
        sections.append(
            "Possibly related models from adjacent Telegram posts:\n"
            + "\n".join(related_lines),
        )

    ids = ", ".join(str(part.message_id) for part in unit.parts)
    source_line = (
        f"Imported from Telegram channel {source.channel_id}; model message(s): {ids}."
    )
    if link := source.message_link(unit.first_message_id):
        source_line += f" Source: {link}"
    sections.append(source_line)
    description = "\n\n".join(sections)
    return description if len(description) <= 2000 else description[:1999] + "…"


def _work_items(
    bundles: Iterable[ImportBundle],
) -> Iterator[tuple[LogicalModel, tuple[MediaRef, ...], tuple[LogicalModel, ...]]]:
    """Flatten bundles into one unit of work per logical model, in discovery order."""
    for bundle in bundles:
        for index, unit in enumerate(bundle.models):
            yield (
                unit,
                bundle.attachments if index == 0 else (),
                bundle.models[1:] if index == 0 else (),
            )


class ChannelImporter:
    def __init__(
        self,
        *,
        telegram: TelegramSource,
        alexandria: AlexandriaClient,
        tracker: ImportTracker,
        work_root: Path | None = None,
        concurrency: int = 1,
    ) -> None:
        if concurrency < 1:
            raise ValueError("Import concurrency must be at least 1")
        self.telegram = telegram
        self.alexandria = alexandria
        self.tracker = tracker
        self.work_root = work_root
        self.concurrency = concurrency
        self._signatures = SignatureGate()

    async def run(self, refs: list[MediaRef]) -> dict[str, int]:
        self._cleanup_stale_work()
        bundles = list(build_bundles(self.telegram.channel_id, refs))
        total_units = sum(len(bundle.models) for bundle in bundles)
        log.info(
            "Discovered %d importable models in %d bundles; importing %d at a time",
            total_units,
            len(bundles),
            self.concurrency,
        )
        # Semaphore acquisition is FIFO, so a concurrency of 1 keeps the original
        # strict discovery order.
        slots = asyncio.Semaphore(self.concurrency)

        async def guarded(
            unit: LogicalModel,
            attachments: tuple[MediaRef, ...],
            related: tuple[LogicalModel, ...],
        ) -> None:
            async with slots:
                await self._process_unit(unit, attachments, related)

        results = await asyncio.gather(
            *(guarded(*item) for item in _work_items(bundles)),
            return_exceptions=True,
        )
        # Plain gather propagates the first failure while its siblings keep
        # running, which would leave tasks writing to a tracker and HTTP client
        # the caller is about to close. Collect every result, then re-raise.
        for result in results:
            if isinstance(result, BaseException):
                raise result
        return self.tracker.counts()

    async def _process_unit(
        self,
        unit: LogicalModel,
        attachments: tuple[MediaRef, ...],
        related: tuple[LogicalModel, ...],
    ) -> None:
        expected_upload_filename = upload_filename(self.telegram.channel_id, unit)
        record = self.tracker.discover(
            import_key=unit.key,
            source_channel_id=self.telegram.channel_id,
            logical_filename=unit.logical_filename,
            upload_filename=expected_upload_filename,
            model_message_ids=tuple(part.message_id for part in unit.parts),
            attachment_message_ids=tuple(item.message_id for item in attachments),
            telegram_signature=telegram_media_signature(unit),
        )
        if record.status == "completed":
            log.info("Skipping completed model %s", unit.logical_filename)
            return

        log.info("Importing %s", unit.logical_filename)
        try:
            validate_logical_model(unit)
            # Signatures are held for the rest of this import so a concurrent twin
            # waits here and then sees this model as a completed duplicate source.
            # A holder always owns a concurrency slot, so waiting on one cannot
            # deadlock against the semaphore.
            async with AsyncExitStack() as holds:
                if record.telegram_signature:
                    await holds.enter_async_context(
                        self._signatures.hold(
                            "telegram_signature", record.telegram_signature
                        ),
                    )
                dedupe_eligible = (
                    record.status
                    in {"discovered", "failed", "downloading", "uploading"}
                    and record.session_id is None
                    and record.model_id is None
                )
                if dedupe_eligible and record.telegram_signature:
                    duplicate = await self._find_ready_duplicate(
                        "telegram_signature",
                        record.telegram_signature,
                        exclude_import_key=unit.key,
                    )
                    if duplicate:
                        self._record_duplicate(
                            unit, duplicate, "Telegram media identity"
                        )
                        return
                with tempfile.TemporaryDirectory(
                    prefix=f"alexandria-tg-{unit.key[:8]}-",
                    dir=self.work_root,
                ) as temp:
                    await self._resume_or_import(
                        unit,
                        attachments,
                        related,
                        record,
                        Path(temp),
                        holds,
                    )
        except DuplicateModelFound as duplicate:
            self._record_duplicate(unit, duplicate.original, duplicate.signature_type)
        except CompletionUncertain as error:
            self.tracker.update(unit.key, "completion_uncertain", error=str(error))
            log.error(
                "Refusing to duplicate uncertain model %s: %s",
                unit.logical_filename,
                error,
            )
        # One bad Telegram post must not prevent independent later models from importing.
        except Exception as error:  # noqa: BLE001
            self.tracker.update(unit.key, "failed", error=str(error))
            log.error("Failed to import %s: %s", unit.logical_filename, error)

    def _record_duplicate(
        self,
        unit: LogicalModel,
        original: ImportRecord,
        signature_type: str,
    ) -> None:
        self.tracker.mark_duplicate(unit.key, original)
        log.info(
            "Skipped duplicate %s by %s; reusing Alexandria model %s",
            unit.logical_filename,
            signature_type,
            original.model_id,
        )

    async def _find_ready_duplicate(
        self,
        signature_type: str,
        signature: str,
        *,
        exclude_import_key: str,
    ) -> ImportRecord | None:
        candidates = self.tracker.completed_by_signature(
            signature_type,
            signature,
            exclude_import_key=exclude_import_key,
        )
        for candidate in candidates:
            if not candidate.model_id:
                continue
            try:
                status = await self.alexandria.get_model_status(candidate.model_id)
            except AlexandriaError as error:
                if error.status_code == 404:
                    continue
                raise
            if status.get("status") == "ready":
                return candidate
        return None

    def _cleanup_stale_work(self) -> None:
        if self.work_root is None:
            return
        self.work_root.mkdir(parents=True, exist_ok=True)
        for child in self.work_root.glob("alexandria-tg-*"):
            try:
                if child.is_symlink() or child.is_file():
                    child.unlink(missing_ok=True)
                elif child.is_dir():
                    shutil.rmtree(child)
                log.info("Removed stale importer work directory %s", child)
            except OSError as error:
                log.warning(
                    "Could not remove stale importer work directory %s: %s",
                    child,
                    error,
                )

    async def _resume_or_import(
        self,
        unit: LogicalModel,
        attachments: tuple[MediaRef, ...],
        related: tuple[LogicalModel, ...],
        record: ImportRecord,
        work_dir: Path,
        holds: AsyncExitStack,
    ) -> None:
        session = await self._recover_session(record)
        if session is None:
            session = await self._start_session(unit, work_dir, holds)
            record = self.tracker.update(
                unit.key,
                "scanning",
                session_id=session["id"],
            )
        else:
            record = self.tracker.update(
                unit.key,
                record.status,
                session_id=session["id"],
                model_id=session.get("modelId"),
            )

        session_id = session["id"]
        status = session["status"]
        if status == "committed":
            self.tracker.update(
                unit.key,
                "completed",
                session_id=session_id,
                model_id=session.get("modelId"),
            )
            return
        if status == "error":
            await self._handle_error_session(unit, session)

        if status == "scanning":
            session = await self.alexandria.wait_for_session(
                session_id,
                {"ready_for_review", "committed"},
            )
            status = session["status"]
        if status == "error":
            await self._handle_error_session(unit, session)
        if status == "committed":
            self.tracker.update(
                unit.key,
                "completed",
                session_id=session_id,
                model_id=session.get("modelId"),
            )
            return

        if status == "ready_for_review":
            if attachments:
                present_names = session_filenames(session)
                missing = tuple(
                    item
                    for item in attachments
                    if attachment_upload_name(item) not in present_names
                )
                for offset in range(0, len(missing), 100):
                    batch = missing[offset : offset + 100]
                    for item in batch:
                        attachment_path = await self.telegram.download(item, work_dir)
                        try:
                            session = await self.alexandria.append_files(
                                session_id,
                                (attachment_path,),
                                (attachment_upload_name(item),),
                            )
                        finally:
                            attachment_path.unlink(missing_ok=True)
                self.tracker.update(
                    unit.key, "attachments_uploaded", session_id=session_id
                )

            model_id = await self.alexandria.commit(
                session_id,
                model_name=model_name_from_filename(unit.logical_filename)
                or "Telegram model",
                description=build_description(
                    self.telegram, unit, attachments, related
                ),
            )
            self.tracker.update(
                unit.key,
                "committing",
                session_id=session_id,
                model_id=model_id,
            )
            status = "committing"

        if status == "committing":
            session = await self.alexandria.wait_for_session(session_id, {"committed"})
            if session["status"] == "error":
                await self._handle_error_session(unit, session)
            self.tracker.update(
                unit.key,
                "completed",
                session_id=session_id,
                model_id=session.get("modelId"),
            )
            log.info(
                "Imported %s as Alexandria model %s",
                unit.logical_filename,
                session.get("modelId"),
            )

    async def _recover_session(self, record: ImportRecord) -> dict[str, Any] | None:
        if record.session_id:
            try:
                return await self.alexandria.get_session(record.session_id)
            except AlexandriaError as error:
                if error.status_code != 404:
                    raise
                if record.model_id:
                    try:
                        model_status = await self.alexandria.get_model_status(
                            record.model_id
                        )
                    except AlexandriaError as model_error:
                        raise CompletionUncertain(
                            f"Recorded Alexandria model {record.model_id} cannot be verified; "
                            "refusing to create a duplicate",
                        ) from model_error
                    if model_status.get("status") == "ready":
                        return {
                            "id": record.session_id,
                            "status": "committed",
                            "modelId": record.model_id,
                        }
                    raise CompletionUncertain(
                        f"Recorded Alexandria model {record.model_id} is "
                        f"{model_status.get('status', 'unknown')}; refusing to create a duplicate",
                    )
                self.tracker.clear_session(record.import_key, status="discovered")
        session = await self.alexandria.find_session_by_filename(record.upload_filename)
        return session

    async def _start_session(
        self, unit: LogicalModel, work_dir: Path, holds: AsyncExitStack
    ) -> dict[str, Any]:
        self.tracker.update(unit.key, "downloading")
        multipart = unit.multipart
        names = part_upload_names(self.telegram.channel_id, unit)
        upload_ids: list[str] = []
        content_hashes: list[str] = []
        try:
            for part, name in zip(unit.parts, names, strict=True):
                downloaded = await self.telegram.download(part, work_dir)
                upload_path = downloaded
                upload_name = name
                try:
                    part_hash, actual_size = await asyncio.to_thread(
                        _hash_file, downloaded
                    )
                    if part.size and actual_size != part.size:
                        raise RuntimeError(
                            f"Telegram download size mismatch for {part.filename}: "
                            f"expected {part.size}, received {actual_size}",
                        )
                    content_hashes.append(part_hash)
                    if len(content_hashes) == len(unit.parts):
                        signature = content_signature(unit, content_hashes)
                        self.tracker.set_content_signature(unit.key, signature)
                        # Always acquired after the Telegram hold, so two units
                        # can never take the two holds in opposing orders.
                        await holds.enter_async_context(
                            self._signatures.hold("content_signature", signature),
                        )
                        duplicate = await self._find_ready_duplicate(
                            "content_signature",
                            signature,
                            exclude_import_key=unit.key,
                        )
                        if duplicate:
                            raise DuplicateModelFound(duplicate, "SHA-256")
                    if not multipart and not unit.logical_filename.lower().endswith(
                        ARCHIVE_EXTENSIONS
                    ):
                        upload_path = work_dir / upload_filename(
                            self.telegram.channel_id, unit
                        )
                        with zipfile.ZipFile(
                            upload_path,
                            "w",
                            compression=zipfile.ZIP_DEFLATED,
                        ) as archive:
                            archive.write(
                                downloaded,
                                arcname=safe_filename(part.filename, "model"),
                            )
                        upload_name = upload_path.name
                    self.tracker.update(unit.key, "uploading")
                    upload_ids.append(
                        await self.alexandria.upload_file(
                            upload_path,
                            upload_name,
                            multipart=multipart,
                        ),
                    )
                finally:
                    downloaded.unlink(missing_ok=True)
                    if upload_path != downloaded:
                        upload_path.unlink(missing_ok=True)
            session_id = await self.alexandria.complete_upload(
                upload_ids,
                multipart=multipart,
            )
        except Exception:
            await self.alexandria.abort_uploads(upload_ids)
            raise
        return await self.alexandria.get_session(session_id)

    async def _handle_error_session(
        self, unit: LogicalModel, session: dict[str, Any]
    ) -> None:
        error = session.get("error") or "Alexandria ingestion failed"
        if session.get("modelId"):
            self.tracker.update(
                unit.key,
                "failed",
                session_id=session["id"],
                model_id=session["modelId"],
                error=error,
            )
        else:
            try:
                await self.alexandria.discard_session(session["id"])
            finally:
                self.tracker.clear_session(unit.key, status="failed", error=error)
        raise AlexandriaError(error)


def describe_plan(channel_id: int, refs: list[MediaRef]) -> str:
    lines: list[str] = []
    for bundle_number, bundle in enumerate(build_bundles(channel_id, refs), start=1):
        lines.append(
            f"Bundle {bundle_number}: {len(bundle.attachments)} preceding attachment(s), "
            f"{len(bundle.models)} model(s)",
        )
        for index, unit in enumerate(bundle.models):
            role = "primary" if index == 0 else "possibly related"
            parts = ", ".join(part.filename for part in unit.parts)
            lines.append(f"  - {role}: {unit.logical_filename} [{parts}]")
    return "\n".join(lines) if lines else "No model media found."
