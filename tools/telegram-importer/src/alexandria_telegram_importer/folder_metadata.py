from __future__ import annotations

import json
import logging
import re
from collections.abc import Sequence
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

SCHEMA_VERSION = 1
METADATA_FILENAME = "metadata.json"

# Fields the commit endpoint accepts. Kept in sync with
# packages/shared/src/validation/upload.ts batchUploadMetadataSchema.
COMMIT_FIELDS = (
    "modelName",
    "description",
    "collectionId",
    "newCollectionName",
    "artist",
    "tags",
    "metadata",
    "options",
)
_INHERITED_SCALARS = ("description", "collectionId", "newCollectionName", "artist")
_INHERITED_MAPPINGS = ("metadata", "options")

_FOLDER_PREFIX_RE = re.compile(r"^\d{4,}-")


def _load(folder: Path) -> tuple[dict[str, Any] | None, str | None]:
    """Return (payload, error).

    `error` is set only when the file exists but cannot be used, which is
    distinct from it being absent. Callers that are about to overwrite or
    commit on the strength of this file need to tell those two apart: a
    typo in a hand-edited file must never be treated as "no metadata".
    """
    path = folder / METADATA_FILENAME
    if not path.is_file():
        return None, None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return None, f"{METADATA_FILENAME} could not be read: {error}"
    if not isinstance(payload, dict):
        return None, f"{METADATA_FILENAME} must contain a JSON object"
    return payload, None


def read_metadata(folder: Path) -> dict[str, Any] | None:
    """Read one folder's metadata.json, or None when it is absent or unusable."""
    payload, error = _load(folder)
    if error:
        log.warning("Ignoring %s: %s", folder / METADATA_FILENAME, error)
    return payload


def metadata_error(folder: Path) -> str | None:
    """A message when this folder's metadata.json exists but is unusable."""
    return _load(folder)[1]


def write_metadata(folder: Path, payload: dict[str, Any]) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    document = {"schemaVersion": SCHEMA_VERSION, **payload}
    (folder / METADATA_FILENAME).write_text(
        json.dumps(document, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def merge_chain(chain: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Merge metadata from outermost container to model folder.

    modelName deliberately does not inherit: a release-level name would
    otherwise commit every model in the release under one title.
    """
    merged: dict[str, Any] = {}
    tags: list[str] = []
    for level, payload in enumerate(chain):
        for key in _INHERITED_SCALARS:
            if payload.get(key) is not None:
                merged[key] = payload[key]
        for key in _INHERITED_MAPPINGS:
            value = payload.get(key)
            if isinstance(value, dict):
                merged.setdefault(key, {}).update(value)
        for tag in payload.get("tags") or []:
            if tag not in tags:
                tags.append(tag)
        if level == len(chain) - 1 and payload.get("modelName"):
            merged["modelName"] = payload["modelName"]
    if tags:
        merged["tags"] = tags
    return merged


def batch_metadata(effective: dict[str, Any]) -> dict[str, Any]:
    """Reduce merged metadata to the fields the commit endpoint accepts."""
    return {key: effective[key] for key in COMMIT_FIELDS if effective.get(key) is not None}


def model_name_from_folder(name: str) -> str:
    stripped = _FOLDER_PREFIX_RE.sub("", name)
    cleaned = stripped.replace("_", " ").replace("-", " ").strip()
    return cleaned or name
