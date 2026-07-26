from __future__ import annotations

import hashlib
import logging
import re
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

from .folder_metadata import write_metadata
from .grouping import model_name_from_filename, safe_filename
from .models import ImportBundle, MediaRef
from .progress import ModelProgress, NullModelProgress

log = logging.getLogger(__name__)

MAX_SLUG_LENGTH = 60
MAX_DESCRIPTION_LENGTH = 2000

_SLUG_STRIP_RE = re.compile(r"[^a-z0-9]+")


def bundle_message_ids(bundle: ImportBundle) -> tuple[int, ...]:
    return tuple(
        sorted(part.message_id for unit in bundle.models for part in unit.parts)
    )


def bundle_key(channel_id: int, bundle: ImportBundle) -> str:
    """Key one staged bundle.

    The `staged:` prefix keeps this key space disjoint from grouping's
    per-logical-model `import_key`, which hashes the same message IDs.
    """
    ids = ",".join(str(message_id) for message_id in bundle_message_ids(bundle))
    return hashlib.sha256(f"staged:{channel_id}:{ids}".encode()).hexdigest()[:24]


def slug(value: str) -> str:
    return _SLUG_STRIP_RE.sub("-", value.lower()).strip("-")[:MAX_SLUG_LENGTH].strip("-")


def bundle_folder_name(bundle: ImportBundle) -> str:
    # partition_logical_models sorts by first_message_id, so models[0] is earliest.
    first_message_id = min(unit.first_message_id for unit in bundle.models)
    name = slug(model_name_from_filename(bundle.models[0].logical_filename))
    return f"{first_message_id:06d}-{name}" if name else f"{first_message_id:06d}"


class MediaDownloader(Protocol):
    channel_id: int

    async def download(
        self, ref: MediaRef, directory: Path, *, on_progress: Any = None
    ) -> Path: ...

    def message_link(self, message_id: int) -> str | None: ...


def unique_child(parent: Path, name: str) -> Path:
    """A path under parent that does not exist yet, suffixing -2, -3 on collision."""
    candidate = parent / name
    index = 2
    while candidate.exists():
        candidate = parent / f"{name}-{index}"
        index += 1
    return candidate


def _unique_filename(directory: Path, filename: str) -> Path:
    stem, dot, extension = filename.partition(".")
    candidate = directory / filename
    index = 2
    while candidate.exists():
        candidate = directory / f"{stem}-{index}{dot}{extension}"
        index += 1
    return candidate


def bundle_description(source: MediaDownloader, bundle: ImportBundle) -> str:
    """Compose one description for a whole bundle.

    Mirrors importer.build_description, but scoped to every model in the
    bundle rather than one logical model, since a staged folder is a bundle.
    """
    sections: list[str] = []
    seen: set[str] = set()
    parts = [part for unit in bundle.models for part in unit.parts]
    for ref in (*bundle.attachments, *parts):
        if ref.caption and ref.caption not in seen:
            sections.append(ref.caption)
            seen.add(ref.caption)

    ids = ", ".join(str(message_id) for message_id in bundle_message_ids(bundle))
    source_line = (
        f"Imported from Telegram channel {source.channel_id}; model message(s): {ids}."
    )
    first = min(unit.first_message_id for unit in bundle.models)
    if link := source.message_link(first):
        source_line += f" Source: {link}"
    sections.append(source_line)
    description = "\n\n".join(sections)
    if len(description) > MAX_DESCRIPTION_LENGTH:
        return description[: MAX_DESCRIPTION_LENGTH - 1] + "…"
    return description


class BundleStager:
    def __init__(self, *, telegram: MediaDownloader, root: Path) -> None:
        self.telegram = telegram
        self.root = root

    async def stage(
        self, bundle: ImportBundle, handle: ModelProgress | None = None
    ) -> Path:
        """Download one bundle into its own folder, or leave nothing behind."""
        handle = handle or NullModelProgress()
        self.root.mkdir(parents=True, exist_ok=True)
        folder = unique_child(self.root, bundle_folder_name(bundle))
        folder.mkdir()
        try:
            models_dir = folder / "models"
            images_dir = folder / "images"
            models_dir.mkdir()
            images_dir.mkdir()

            parts = [part for unit in bundle.models for part in unit.parts]
            for ref in parts:
                await self._fetch(ref, models_dir, handle)
            for ref in bundle.attachments:
                await self._fetch(ref, images_dir, handle)

            write_metadata(
                folder,
                {
                    "modelName": model_name_from_filename(
                        bundle.models[0].logical_filename
                    ),
                    "description": bundle_description(self.telegram, bundle),
                    "artist": None,
                    "tags": [],
                    "metadata": {},
                    "options": {},
                    "collectionId": None,
                    "newCollectionName": None,
                    "source": {
                        "channelId": self.telegram.channel_id,
                        "channelUsername": getattr(
                            self.telegram, "channel_username", None
                        ),
                        "bundleKey": bundle_key(self.telegram.channel_id, bundle),
                        "modelMessageIds": list(bundle_message_ids(bundle)),
                        "attachmentMessageIds": [
                            ref.message_id for ref in bundle.attachments
                        ],
                        "link": self.telegram.message_link(
                            min(unit.first_message_id for unit in bundle.models)
                        ),
                        "downloadedAt": datetime.now(UTC).isoformat(),
                    },
                    "result": None,
                },
            )
        except BaseException:
            # A half-staged folder would upload as an incomplete model, so the
            # bundle is left entirely unstaged and retried on the next run.
            shutil.rmtree(folder, ignore_errors=True)
            raise
        return folder

    async def _fetch(
        self, ref: MediaRef, directory: Path, handle: ModelProgress
    ) -> None:
        with handle.transfer("download", ref.filename) as transfer:
            downloaded = await self.telegram.download(
                ref, directory, on_progress=transfer.advance
            )
        target = _unique_filename(directory, safe_filename(ref.filename, "media"))
        downloaded.rename(target)
