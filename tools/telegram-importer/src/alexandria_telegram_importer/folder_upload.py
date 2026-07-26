from __future__ import annotations

import asyncio
import json
import logging
import shutil
import tempfile
import zipfile
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .folder_metadata import (
    METADATA_FILENAME,
    batch_metadata,
    merge_chain,
    metadata_error,
    model_name_from_folder,
    read_metadata,
    write_metadata,
)
from .grouping import safe_filename
from .progress import (
    ModelProgress,
    NullModelProgress,
    NullProgress,
    ProgressReporter,
    guarded_model,
    guarded_reporter,
)
from .staging import unique_child

log = logging.getLogger(__name__)

MODELS_DIRNAME = "models"
IMAGES_DIRNAME = "images"
UPLOADED_DIRNAME = "uploaded"
FAILED_DIRNAME = "failed"
RESERVED_DIRNAMES = frozenset({UPLOADED_DIRNAME, FAILED_DIRNAME})
RESULT_FILENAME = "result.json"


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

    # The staging root participates in the chain like any container, so it is
    # the natural place for channel-wide defaults.
    root_chain: tuple[dict[str, Any], ...] = (read_metadata(root) or {},)
    root_images = root / IMAGES_DIRNAME
    root_image_dirs = (root_images,) if root_images.is_dir() else ()

    for child in _child_directories(root):
        _visit(child, root_chain, root_image_dirs, found, ambiguous)
    return found, ambiguous


def _child_directories(directory: Path) -> list[Path]:
    """Subdirectories that can hold model folders, at any depth."""
    return [
        child
        for child in sorted(directory.iterdir())
        if child.is_dir()
        and child.name not in RESERVED_DIRNAMES
        and child.name not in {MODELS_DIRNAME, IMAGES_DIRNAME}
    ]


def _visit(
    directory: Path,
    chain: tuple[dict[str, Any], ...],
    image_dirs: tuple[Path, ...],
    found: list[ModelFolder],
    ambiguous: list[tuple[Path, str]],
) -> None:
    chain = (*chain, read_metadata(directory) or {})
    has_models = (directory / MODELS_DIRNAME).is_dir()
    subdirectories = _child_directories(directory)

    if has_models:
        # A model folder commits on the strength of its own metadata.json, so a
        # typo in one must not quietly produce a wrongly-named model. Container
        # files stay lenient: the operator never edited those.
        if error := metadata_error(directory):
            ambiguous.append((directory, error))
            return
        nested: list[ModelFolder] = []
        nested_ambiguous: list[tuple[Path, str]] = []
        for child in subdirectories:
            _visit(child, chain, image_dirs, nested, nested_ambiguous)
        if nested or nested_ambiguous:
            reason = (
                f"holds its own {MODELS_DIRNAME}/ and model folders beneath it; "
                f"finish the split by emptying {MODELS_DIRNAME}/"
            )
            ambiguous.append((directory, reason))
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


def build_folder_archive(
    folder: ModelFolder,
    images: tuple[Path, ...],
    work_dir: Path,
    model_name: str,
) -> Path:
    """Create one ZIP of the complete staged model folder.

    Alexandria receives the operator's curated folder as one archive, rather
    than a models-only upload followed by separate image attachments. Inherited
    container images are placed under the model folder's `images/` directory,
    preserving the staged flow's existing image inheritance behavior.
    """
    if not folder.models_dir.is_dir():
        raise ValueError(f"{folder.models_dir} is missing")
    if not any(folder.models_dir.iterdir()):
        raise ValueError(f"{folder.models_dir} is empty")

    archive_path = work_dir / f"{safe_filename(model_name, 'model')}.zip"
    members = {
        str(path.relative_to(folder.path.parent)): path
        for path in sorted(folder.path.rglob("*"))
        if path.is_file()
    }
    for image in images:
        members[str(Path(folder.path.name) / IMAGES_DIRNAME / image.name)] = image

    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, path in sorted(members.items()):
            archive.write(path, arcname=name)
    return archive_path


def dispose(
    folder: Path, root: Path, destination_dirname: str, result: dict[str, Any]
) -> Path:
    """Move one settled model folder under uploaded/ or failed/.

    The path relative to the staging root is preserved, so a release that
    settles a few folders at a time stays recognizable, and each ancestor's
    metadata.json is copied so the archived copy still carries its defaults.
    """
    relative = folder.relative_to(root)
    destination_parent = root / destination_dirname / relative.parent
    destination_parent.mkdir(parents=True, exist_ok=True)
    destination = unique_child(destination_parent, folder.name)

    # Never rewrite a file we could not parse — it holds hand-typed values that
    # exist nowhere else, and `or {}` would replace them with the result alone.
    if metadata_error(folder):
        (folder / RESULT_FILENAME).write_text(
            json.dumps(result, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    else:
        payload = read_metadata(folder) or {}
        payload["result"] = result
        write_metadata(folder, payload)

    shutil.move(str(folder), str(destination))

    ancestor = folder.parent
    mirrored = destination_parent
    while ancestor != root:
        source_metadata = ancestor / METADATA_FILENAME
        if source_metadata.is_file() and not (mirrored / METADATA_FILENAME).exists():
            shutil.copy2(source_metadata, mirrored / METADATA_FILENAME)
        ancestor = ancestor.parent
        mirrored = mirrored.parent

    _prune_empty_containers(folder.parent, root)
    return destination


def _prune_empty_containers(directory: Path, root: Path) -> None:
    """Remove containers that hold nothing but their own metadata.json.

    Emptiness is judged by what is actually on disk, not by whether `discover`
    can still find a model folder. A container may hold an unsplit archive, a
    half-organized subfolder, or shared images — none of which `discover` sees,
    and all of which are the operator's work in progress.
    """
    while directory != root and directory.is_dir():
        leftovers = [
            child
            for child in directory.iterdir()
            if child.name not in {METADATA_FILENAME, RESULT_FILENAME}
        ]
        if leftovers:
            return
        try:
            shutil.rmtree(directory)
            log.info("Removed emptied container %s", directory)
        except OSError as error:
            log.warning("Could not remove emptied container %s: %s", directory, error)
            return
        directory = directory.parent


def _uploaded_at() -> dict[str, str]:
    return {"uploadedAt": datetime.now(UTC).isoformat()}


def _failed_at() -> dict[str, str]:
    return {"failedAt": datetime.now(UTC).isoformat()}


class FolderUploader:
    """Uploads hand-curated folders.

    Performs no deduplication by design: the folders are the operator's, and
    the phases share no state so that folders can be split, merged, renamed,
    and recompressed freely between them.
    """

    def __init__(
        self,
        *,
        alexandria: Any,
        work_root: Path,
        concurrency: int = 1,
        progress: ProgressReporter | None = None,
    ) -> None:
        if concurrency < 1:
            raise ValueError("Upload concurrency must be at least 1")
        self.alexandria = alexandria
        self.work_root = work_root
        self.concurrency = concurrency
        self.progress: ProgressReporter = progress or NullProgress()

    def image_paths(self, folder: ModelFolder) -> tuple[Path, ...]:
        """Every image to append, with the model's own file winning a name clash."""
        by_name: dict[str, Path] = {}
        for directory in folder.image_dirs:
            for path in sorted(directory.iterdir()):
                if path.is_file():
                    by_name[path.name] = path
        return tuple(by_name.values())

    async def run(self, root: Path) -> dict[str, int]:
        found, ambiguous = discover(root)
        outcomes: Counter[str] = Counter()
        settled = 0
        total = len(found) + len(ambiguous)

        for path, reason in ambiguous:
            log.error("Skipping ambiguous folder %s: %s", path, reason)
            dispose(path, root, FAILED_DIRNAME, {"error": reason, **_failed_at()})
            outcomes["failed"] += 1
            settled += 1

        self.work_root.mkdir(parents=True, exist_ok=True)
        slots = asyncio.Semaphore(self.concurrency)
        lock = asyncio.Lock()

        async def settle(folder: ModelFolder) -> None:
            nonlocal settled
            async with slots:
                outcome = await self._upload_and_dispose(folder, root)
            async with lock:
                outcomes[outcome] += 1
                settled += 1
                self._report(settled, total, outcomes)

        with guarded_reporter(self.progress):
            self._report(settled, total, outcomes)
            results = await asyncio.gather(
                *(settle(folder) for folder in found),
                return_exceptions=True,
            )
        for result in results:
            if isinstance(result, BaseException):
                raise result
        return dict(outcomes)

    def _report(self, done: int, total: int, outcomes: Counter[str]) -> None:
        try:
            self.progress.totals(done, total, dict(outcomes))
        except Exception as error:  # noqa: BLE001 - a display fault is not an upload fault
            log.debug("Progress reporter could not record totals: %s", error)

    async def _upload_and_dispose(self, folder: ModelFolder, root: Path) -> str:
        log.info("Uploading %s", folder.path.name)
        session_out: dict[str, str] = {}
        try:
            with guarded_model(self.progress, folder.path.name, parts=1) as handle:
                model_id = await self.upload(folder, handle, session_out)
        # One bad folder must not stop the rest of the staging directory.
        except Exception as error:  # noqa: BLE001
            log.error("Failed to upload %s: %s", folder.path.name, error)
            dispose(
                folder.path,
                root,
                FAILED_DIRNAME,
                {"error": str(error), **session_out, **_failed_at()},
            )
            return "failed"
        dispose(
            folder.path, root, UPLOADED_DIRNAME, {"modelId": model_id, **_uploaded_at()}
        )
        log.info("Uploaded %s as Alexandria model %s", folder.path.name, model_id)
        return "completed"

    async def upload(
        self,
        folder: ModelFolder,
        handle: ModelProgress | None = None,
        session_out: dict[str, str] | None = None,
    ) -> str:
        handle = handle or NullModelProgress()
        effective = folder.metadata
        payload = batch_metadata(effective)
        payload["modelName"] = folder.model_name

        # upload() is public and callable without run(), so it owns creating
        # the work root rather than relying on the caller having done so.
        self.work_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix="alexandria-folder-", dir=self.work_root
        ) as temp:
            handle.phase("packaging")
            # Zipping an arbitrary tree can take minutes; off-thread so it does
            # not stall sibling transfers and their progress at --concurrency > 1.
            archive_path = await asyncio.to_thread(
                build_folder_archive,
                folder,
                self.image_paths(folder),
                Path(temp),
                payload["modelName"],
            )

            upload_ids: list[str] = []
            try:
                with handle.transfer("upload", archive_path.name) as transfer:
                    upload_ids.append(
                        await self.alexandria.upload_file(
                            archive_path,
                            archive_path.name,
                            multipart=False,
                            on_progress=transfer.advance,
                        ),
                    )
                session_id = await self.alexandria.complete_upload(upload_ids, multipart=False)
            except Exception:
                await self.alexandria.abort_uploads(upload_ids)
                raise

            if session_out is not None:
                session_out["sessionId"] = session_id
            handle.phase("scanning")
            session = await self.alexandria.wait_for_session(
                session_id, {"ready_for_review"}
            )
            if session["status"] == "error":
                raise RuntimeError(session.get("error") or "Alexandria ingestion failed")

            handle.phase("committing")
            await self.alexandria.commit(
                session_id,
                model_name=payload.pop("modelName"),
                description=effective.get("description"),
                batch_metadata=payload,
            )
            committed = await self.alexandria.wait_for_session(session_id, {"committed"})
            if committed["status"] == "error":
                raise RuntimeError(committed.get("error") or "Alexandria commit failed")
            return committed["modelId"]


def describe_staging(root: Path) -> str:
    """Dry-run report for the upload phase: what would be uploaded, and how."""
    found, ambiguous = discover(root)
    lines: list[str] = []
    for folder in found:
        try:
            if not folder.models_dir.is_dir():
                raise ValueError(f"{folder.models_dir} is missing")
            if not any(folder.models_dir.iterdir()):
                raise ValueError(f"{folder.models_dir} is empty")
        except ValueError as error:
            lines.append(f"  SKIP  {folder.path.relative_to(root)}: {error}")
            continue
        images = sum(
            1 for directory in folder.image_dirs for item in directory.iterdir()
            if item.is_file()
        )
        lines.append(
            f"  zip    {folder.path.relative_to(root)} "
            f"-> {folder.model_name!r} ({images} image(s))"
        )
    for path, reason in ambiguous:
        lines.append(f"  FAIL   {path.relative_to(root)}: {reason}")
    if not lines:
        return f"No model folders found in {root}."
    header = f"{len(found)} model folder(s) would be uploaded from {root}"
    if ambiguous:
        header += f"; {len(ambiguous)} would be moved to {FAILED_DIRNAME}/"
    return header + ":\n" + "\n".join(lines)
