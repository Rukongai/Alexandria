from __future__ import annotations

import hashlib
import re

from .grouping import model_name_from_filename
from .models import ImportBundle

MAX_SLUG_LENGTH = 60

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
