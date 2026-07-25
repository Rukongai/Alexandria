from __future__ import annotations

import logging
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .folder_metadata import merge_chain, model_name_from_folder, read_metadata
from .grouping import (
    ARCHIVE_EXTENSIONS,
    multipart_part_role,
    partition_logical_models,
    safe_filename,
    validate_logical_model,
)
from .models import MediaKind, MediaRef

log = logging.getLogger(__name__)

MODELS_DIRNAME = "models"
IMAGES_DIRNAME = "images"
UPLOADED_DIRNAME = "uploaded"
FAILED_DIRNAME = "failed"
RESERVED_DIRNAMES = frozenset({UPLOADED_DIRNAME, FAILED_DIRNAME})


@dataclass(frozen=True, slots=True)
class ModelFolder:
    path: Path
    chain: tuple[dict[str, Any], ...]
    container_image_dirs: tuple[Path, ...]

    @property
    def metadata(self) -> dict[str, Any]:
        return merge_chain(self.chain)

    @property
    def model_name(self) -> str:
        return self.metadata.get("modelName") or model_name_from_folder(self.path.name)

    @property
    def models_dir(self) -> Path:
        return self.path / MODELS_DIRNAME

    @property
    def image_dirs(self) -> tuple[Path, ...]:
        own = self.path / IMAGES_DIRNAME
        return (*self.container_image_dirs, *((own,) if own.is_dir() else ()))


def discover(root: Path) -> tuple[list[ModelFolder], list[tuple[Path, str]]]:
    """Walk the staging root, returning model folders and ambiguous folders.

    A directory holding `models/` is a model folder. A directory holding only
    subdirectories is a container and is recursed into. A directory holding
    both is a half-finished split: uploading it would commit the leftovers
    and silently drop everything already moved into the children, so it is
    reported instead.
    """
    found: list[ModelFolder] = []
    ambiguous: list[tuple[Path, str]] = []
    if not root.is_dir():
        return found, ambiguous
    for child in sorted(root.iterdir()):
        if child.is_dir() and child.name not in RESERVED_DIRNAMES:
            _visit(child, (), (), found, ambiguous)
    return found, ambiguous


def _visit(
    directory: Path,
    chain: tuple[dict[str, Any], ...],
    image_dirs: tuple[Path, ...],
    found: list[ModelFolder],
    ambiguous: list[tuple[Path, str]],
) -> None:
    chain = (*chain, read_metadata(directory) or {})
    has_models = (directory / MODELS_DIRNAME).is_dir()
    subdirectories = [
        child
        for child in sorted(directory.iterdir())
        if child.is_dir() and child.name not in {MODELS_DIRNAME, IMAGES_DIRNAME}
    ]

    if has_models:
        nested: list[ModelFolder] = []
        nested_ambiguous: list[tuple[Path, str]] = []
        for child in subdirectories:
            _visit(child, chain, image_dirs, nested, nested_ambiguous)
        if nested or nested_ambiguous:
            ambiguous.append(
                (
                    directory,
                    f"holds its own {MODELS_DIRNAME}/ and model folders beneath it; "
                    f"finish the split by emptying {MODELS_DIRNAME}/",
                ),
            )
            return
        found.append(
            ModelFolder(path=directory, chain=chain, container_image_dirs=image_dirs),
        )
        return

    own_images = directory / IMAGES_DIRNAME
    if own_images.is_dir():
        image_dirs = (*image_dirs, own_images)
    for child in subdirectories:
        _visit(child, chain, image_dirs, found, ambiguous)


@dataclass(frozen=True, slots=True)
class ModelsPlan:
    kind: str  # "as_is" | "split" | "zip"
    paths: tuple[Path, ...]


def _is_split_member(filename: str) -> bool:
    try:
        multipart_part_role(filename)
    except ValueError:
        return False
    return True


def _split_order(entries: list[Path]) -> tuple[Path, ...] | None:
    """Order entries as one split set, or None when they are not one.

    Reuses grouping's part detection and validation so the importer and the
    staged flow agree on what a complete set is.
    """
    if len(entries) < 2 or not all(entry.is_file() for entry in entries):
        return None
    if not all(_is_split_member(entry.name) for entry in entries):
        return None
    refs = [
        MediaRef(message_id=index, filename=entry.name, kind=MediaKind.MODEL)
        for index, entry in enumerate(entries)
    ]
    units = partition_logical_models(0, refs)
    if len(units) != 1 or not units[0].multipart:
        return None
    try:
        validate_logical_model(units[0])
    except ValueError as error:
        log.info("Not treating %s as a split set: %s", entries[0].parent, error)
        return None
    order = {part.filename: index for index, part in enumerate(units[0].parts)}
    return tuple(sorted(entries, key=lambda entry: order[entry.name]))


def plan_models_dir(models_dir: Path) -> ModelsPlan:
    if not models_dir.is_dir():
        raise ValueError(f"{models_dir} is missing")
    entries = sorted(models_dir.iterdir())
    if not entries:
        raise ValueError(f"{models_dir} is empty")

    only = entries[0]
    if (
        len(entries) == 1
        and only.is_file()
        and only.name.lower().endswith(ARCHIVE_EXTENSIONS)
    ):
        return ModelsPlan(kind="as_is", paths=(only,))

    if ordered := _split_order(entries):
        return ModelsPlan(kind="split", paths=ordered)

    return ModelsPlan(kind="zip", paths=tuple(entries))


def build_upload_paths(
    plan: ModelsPlan, work_dir: Path, model_name: str
) -> tuple[tuple[Path, ...], bool]:
    """Resolve a plan into paths to upload and whether they are a split set.

    An `as_is` or `split` plan uploads the operator's own files untouched —
    that is what makes hand-made compression worth doing.
    """
    if plan.kind == "as_is":
        return plan.paths, False
    if plan.kind == "split":
        return plan.paths, True

    models_dir = plan.paths[0].parent
    archive_path = work_dir / f"{safe_filename(model_name, 'model')}.zip"
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(models_dir.rglob("*")):
            if path.is_file():
                archive.write(path, arcname=str(path.relative_to(models_dir)))
    return (archive_path,), False
