from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable, Iterator
from pathlib import PurePath

from .models import ImportBundle, LogicalModel, MediaKind, MediaRef

ARCHIVE_EXTENSIONS = (".tar.gz", ".tgz", ".zip", ".rar", ".7z")
MODEL_EXTENSIONS = (
    ".3mf",
    ".amf",
    ".blend",
    ".fbx",
    ".obj",
    ".ply",
    ".scad",
    ".step",
    ".stl",
    ".stp",
)

_CLASSIC_PART_RE = re.compile(r"^(?P<base>.+)\.z(?P<part>\d{2})$", re.IGNORECASE)
_NUMBERED_ZIP_RE = re.compile(r"^(?P<base>.+\.zip)\.(?P<part>\d{3})$", re.IGNORECASE)
_RAR_PART_RE = re.compile(r"^(?P<base>.+)\.part(?P<part>\d+)\.rar$", re.IGNORECASE)
MAX_MULTIPART_MEMBERS = 100
MAX_ARCHIVE_MEMBER_BYTES = 5 * 1024 * 1024 * 1024


def safe_filename(filename: str, fallback: str) -> str:
    name = PurePath(filename.replace("\\", "/")).name.replace("\x00", "").strip()
    return name if name not in {"", ".", ".."} else fallback


def is_model_filename(filename: str) -> bool:
    lower = filename.lower()
    if lower.endswith(ARCHIVE_EXTENSIONS + MODEL_EXTENSIONS):
        return True
    return bool(
        _CLASSIC_PART_RE.match(filename)
        or _NUMBERED_ZIP_RE.match(filename)
        or _RAR_PART_RE.match(filename)
    )


def model_name_from_filename(filename: str) -> str:
    name = safe_filename(filename, "Telegram model")
    lower = name.lower()
    for extension in ARCHIVE_EXTENSIONS + MODEL_EXTENSIONS:
        if lower.endswith(extension):
            return name[: -len(extension)].replace("_", " ").replace("-", " ").strip()
    for pattern in (_NUMBERED_ZIP_RE, _RAR_PART_RE, _CLASSIC_PART_RE):
        match = pattern.match(name)
        if match:
            base = match.group("base")
            if base.lower().endswith(".zip"):
                base = base[:-4]
            return base.replace("_", " ").replace("-", " ").strip()
    return name


def _logical_key(channel_id: int, parts: Iterable[MediaRef]) -> str:
    ids = ",".join(
        str(part.message_id) for part in sorted(parts, key=lambda item: item.message_id)
    )
    digest = hashlib.sha256(f"{channel_id}:{ids}".encode()).hexdigest()
    return digest[:24]


def partition_logical_models(
    channel_id: int, refs: Iterable[MediaRef]
) -> tuple[LogicalModel, ...]:
    ordered = list(refs)
    explicit_groups: dict[tuple[str, str], list[MediaRef]] = {}
    for ref in ordered:
        name = ref.filename
        if match := _CLASSIC_PART_RE.match(name):
            base = match.group("base").casefold()
            explicit_groups.setdefault(("classic", base), []).append(ref)
        elif match := _NUMBERED_ZIP_RE.match(name):
            explicit_groups.setdefault(
                ("numbered", match.group("base").casefold()),
                [],
            ).append(ref)
        elif match := _RAR_PART_RE.match(name):
            explicit_groups.setdefault(
                ("rar", match.group("base").casefold()), []
            ).append(ref)

    consumed: set[int] = set()
    units: list[LogicalModel] = []

    for (scheme, base), parts in explicit_groups.items():
        if scheme == "classic":
            terminals = [
                ref
                for ref in ordered
                if ref.message_id not in consumed
                and ref.filename.casefold() == f"{base}.zip"
            ]
            parts.extend(terminals)

        parts.sort(key=lambda item: item.message_id)
        consumed.update(part.message_id for part in parts)
        if scheme == "numbered":
            logical_filename = re.sub(r"\.\d{3}$", "", parts[0].filename)
        elif scheme == "rar":
            logical_filename = (
                f"{_RAR_PART_RE.match(parts[0].filename).group('base')}.rar"  # type: ignore[union-attr]
            )
        else:
            terminal = next(
                (part for part in parts if part.filename.lower().endswith(".zip")), None
            )
            logical_filename = terminal.filename if terminal else f"{base}.zip"
        units.append(
            LogicalModel(
                key=_logical_key(channel_id, parts),
                parts=tuple(parts),
                logical_filename=logical_filename,
                multipart=True,
            ),
        )

    for ref in ordered:
        if ref.message_id in consumed:
            continue
        units.append(
            LogicalModel(
                key=_logical_key(channel_id, (ref,)),
                parts=(ref,),
                logical_filename=ref.filename,
                multipart=False,
            ),
        )

    units.sort(key=lambda unit: unit.first_message_id)
    return tuple(units)


def validate_logical_model(unit: LogicalModel) -> None:
    for part in unit.parts:
        if part.size > MAX_ARCHIVE_MEMBER_BYTES:
            raise ValueError(
                f"{part.filename} exceeds Alexandria's 5 GB per-file upload limit",
            )
    if not unit.multipart:
        return
    if not 2 <= len(unit.parts) <= MAX_MULTIPART_MEMBERS:
        raise ValueError("Split archives must contain between 2 and 100 members")

    names = [part.filename for part in unit.parts]
    lowered = [name.casefold() for name in names]
    if len(set(lowered)) != len(lowered):
        raise ValueError("Split archive contains duplicate member names")

    classic_parts = []
    classic_terminals = []
    numbered_parts = []
    rar_parts = []
    for name in names:
        if match := _RAR_PART_RE.match(name):
            rar_parts.append(
                (match.group("base"), int(match.group("part")), match.group("part"))
            )
        elif match := _CLASSIC_PART_RE.match(name):
            classic_parts.append((match.group("base"), int(match.group("part"))))
        elif match := _NUMBERED_ZIP_RE.match(name):
            numbered_parts.append((match.group("base"), int(match.group("part"))))
        elif name.lower().endswith(".zip"):
            classic_terminals.append(name[:-4])
        else:
            raise ValueError(f"Unrecognized split archive member: {name}")

    if rar_parts:
        if classic_parts or classic_terminals or numbered_parts:
            raise ValueError("Split archive mixes ZIP and RAR naming schemes")
        base = rar_parts[0][0].casefold()
        if not base.strip() or set(base) == {"."}:
            raise ValueError("Split RAR members must have a safe base filename")
        if any(item[0].casefold() != base for item in rar_parts):
            raise ValueError("Split RAR members must share one base filename")
        ordered = sorted(rar_parts, key=lambda item: item[1])
        width = len(ordered[0][2])
        for expected, (_, index, token) in enumerate(ordered, start=1):
            if index != expected:
                raise ValueError(f"Split RAR set is missing part {expected}")
            if token != str(expected).zfill(width):
                raise ValueError("Split RAR members use inconsistent number padding")
        return

    if numbered_parts:
        if classic_parts or classic_terminals:
            raise ValueError("Split ZIP set mixes classic and numbered schemes")
        base = numbered_parts[0][0].casefold()
        if any(item[0].casefold() != base for item in numbered_parts):
            raise ValueError("Numbered ZIP members must share one base filename")
        ordered_indexes = sorted(item[1] for item in numbered_parts)
        if ordered_indexes != list(range(1, len(ordered_indexes) + 1)):
            missing = next(
                index
                for index in range(1, len(ordered_indexes) + 1)
                if index not in ordered_indexes
            )
            raise ValueError(f"Numbered ZIP set is missing part {missing:03d}")
        return

    if not classic_parts or len(classic_terminals) != 1:
        raise ValueError(
            "Classic split ZIP sets require exactly one terminal .zip file"
        )
    base = classic_parts[0][0].casefold()
    if classic_terminals[0].casefold() != base:
        raise ValueError("Classic ZIP members must share one base filename")
    if any(item[0].casefold() != base for item in classic_parts):
        raise ValueError("Classic ZIP members must share one base filename")
    ordered_indexes = sorted(item[1] for item in classic_parts)
    if ordered_indexes != list(range(1, len(ordered_indexes) + 1)):
        missing = next(
            index
            for index in range(1, len(ordered_indexes) + 1)
            if index not in ordered_indexes
        )
        raise ValueError(f"Classic ZIP set is missing part {missing:02d}")


def build_bundles(channel_id: int, refs: Iterable[MediaRef]) -> Iterator[ImportBundle]:
    current_models: list[MediaRef] = []
    current_attachments: list[MediaRef] = []
    pending_attachments: list[MediaRef] = []

    for ref in refs:
        if ref.kind == MediaKind.MODEL:
            if current_models and pending_attachments:
                yield ImportBundle(
                    attachments=tuple(current_attachments),
                    models=partition_logical_models(channel_id, current_models),
                )
                current_models = []
                current_attachments = pending_attachments
                pending_attachments = []
            elif not current_models:
                current_attachments = pending_attachments
                pending_attachments = []
            current_models.append(ref)
        else:
            pending_attachments.append(ref)

    if current_models:
        yield ImportBundle(
            attachments=tuple(current_attachments),
            models=partition_logical_models(channel_id, current_models),
        )
