from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .folder_metadata import merge_chain, model_name_from_folder, read_metadata

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
