from __future__ import annotations

import json
import logging
import math
import re
from collections.abc import Sequence
from datetime import date, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

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

# Matches only the six-digit prefix bundle_folder_name writes, so a real
# name like "2001-a-space-odyssey" keeps its leading number.
_FOLDER_PREFIX_RE = re.compile(r"^\d{6}-")


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
    return {
        key: effective[key] for key in COMMIT_FIELDS if effective.get(key) is not None
    }


def normalize_batch_metadata(
    payload: dict[str, Any],
    field_definitions: Sequence[dict[str, Any]],
) -> dict[str, Any]:
    """Match generic metadata values to Alexandria's configured field types."""
    normalized = dict(payload)
    values = payload.get("metadata")
    if values is None:
        return normalized
    if not isinstance(values, dict):
        raise TypeError("metadata must be an object")
    fields = {
        field["slug"]: field
        for field in field_definitions
        if isinstance(field, dict) and isinstance(field.get("slug"), str)
    }
    normalized["metadata"] = {
        slug: _normalize_metadata_value(slug, value, fields.get(slug))
        for slug, value in values.items()
    }
    return normalized


def _normalize_metadata_value(
    slug: str,
    value: Any,
    field: dict[str, Any] | None,
) -> Any:
    if field is None:
        raise ValueError(f"metadata.{slug} is not configured in Alexandria")
    if value is None:
        return None
    field_type = field.get("type")
    config = field.get("config") if isinstance(field.get("config"), dict) else {}

    if field_type == "number":
        if isinstance(value, bool):
            raise ValueError(f"metadata.{slug} must be a number")
        if isinstance(value, (int, float)):
            if not math.isfinite(value):
                raise ValueError(f"metadata.{slug} must be a finite number")
            return value
        if isinstance(value, str):
            try:
                parsed = float(value.strip())
            except ValueError as error:
                raise ValueError(f"metadata.{slug} must be a number") from error
            if not math.isfinite(parsed):
                raise ValueError(f"metadata.{slug} must be a finite number")
            return int(parsed) if parsed.is_integer() else parsed
        raise ValueError(f"metadata.{slug} must be a number")

    if field_type == "boolean":
        if isinstance(value, bool):
            return value
        if isinstance(value, str) and value.strip().casefold() in {"true", "false"}:
            return value.strip().casefold() == "true"
        raise ValueError(f"metadata.{slug} must be a boolean")

    if field_type == "multi_enum":
        source = value if isinstance(value, list) else [value]
        strings = [_metadata_string(slug, item) for item in source]
        if len(strings) > 100:
            raise ValueError(f"metadata.{slug} must contain at most 100 values")
        _validate_enum_options(slug, strings, config)
        return strings

    if field_type not in {"text", "date", "url", "enum"}:
        raise ValueError(f"metadata.{slug} has unsupported field type {field_type!r}")
    string = _metadata_string(slug, value)
    if field_type == "url":
        parsed_url = urlsplit(string)
        if parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc:
            raise ValueError(f"metadata.{slug} must be an HTTP or HTTPS URL")
    elif field_type == "date" and not _is_iso_date(string):
        raise ValueError(f"metadata.{slug} must be a valid ISO date")
    elif field_type == "enum":
        _validate_enum_options(slug, [string], config)
    return string


def _metadata_string(slug: str, value: Any) -> str:
    if isinstance(value, str):
        result = value
    elif isinstance(value, bool):
        result = "true" if value else "false"
    elif isinstance(value, (int, float)) and math.isfinite(value):
        result = str(value)
    else:
        raise ValueError(f"metadata.{slug} cannot be converted to a string")
    if len(result) > 10_000:
        raise ValueError(f"metadata.{slug} must be at most 10000 characters")
    return result


def _validate_enum_options(
    slug: str,
    values: Sequence[str],
    config: dict[str, Any],
) -> None:
    options = config.get("enumOptions")
    if isinstance(options, list) and any(value not in options for value in values):
        raise ValueError(f"metadata.{slug} contains a value not allowed by Alexandria")


def _is_iso_date(value: str) -> bool:
    try:
        date.fromisoformat(value)
        return True
    except ValueError:
        pass
    try:
        datetime.fromisoformat(value)
        return True
    except ValueError:
        return bool(re.fullmatch(r"\d{4}(?:-(?:0[1-9]|1[0-2]))?", value))


def model_name_from_folder(name: str) -> str:
    stripped = _FOLDER_PREFIX_RE.sub("", name)
    cleaned = stripped.replace("_", " ").replace("-", " ").strip()
    return cleaned or name
