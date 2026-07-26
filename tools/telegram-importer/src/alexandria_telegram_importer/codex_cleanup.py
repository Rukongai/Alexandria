from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import signal
import subprocess
import tarfile
import zipfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .folder_upload import ModelFolder, discover

log = logging.getLogger(__name__)

DEFAULT_CLEANUP_TIMEOUT = 60 * 60
SAFE_ENV_NAMES = frozenset(
    {
        "CODEX_CA_CERTIFICATE",
        "CODEX_HOME",
        "CODEX_SQLITE_HOME",
        "HOME",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "LANG",
        "LOGNAME",
        "NO_PROXY",
        "PATH",
        "RUST_LOG",
        "SHELL",
        "SSL_CERT_FILE",
        "TERM",
        "TMPDIR",
        "TZ",
        "USER",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "https_proxy",
        "http_proxy",
        "no_proxy",
    },
)
SUPPORTED_ARCHIVE_SUFFIXES = (
    ".7z",
    ".zip",
    ".rar",
    ".tar.gz",
    ".tgz",
)

CLEANUP_OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "status": {
            "type": "string",
            "enum": ["ready", "needs_review", "failed"],
        },
        "inputFolder": {"type": "string"},
        "outputFolders": {
            "type": "array",
            "items": {"type": "string"},
        },
        "summary": {"type": "string"},
        "warnings": {"type": "array", "items": {"type": "string"}},
        "checks": {
            "type": "object",
            "properties": {
                "archivesTested": {"type": "boolean"},
                "metadataValid": {"type": "boolean"},
                "imagesFlat": {"type": "boolean"},
                "splitComplete": {"type": "boolean"},
            },
            "required": [
                "archivesTested",
                "metadataValid",
                "imagesFlat",
                "splitComplete",
            ],
            "additionalProperties": False,
        },
    },
    "required": [
        "status",
        "inputFolder",
        "outputFolders",
        "summary",
        "warnings",
        "checks",
    ],
    "additionalProperties": False,
}


class CleanupExecutionError(RuntimeError):
    """Codex could not produce a usable cleanup receipt."""


@dataclass(frozen=True, slots=True)
class CleanupReceipt:
    status: str
    input_folder: Path
    output_folders: tuple[Path, ...]
    summary: str
    warnings: tuple[str, ...]
    checks: Mapping[str, bool]

    @classmethod
    def from_payload(cls, payload: Any, *, input_folder: Path) -> CleanupReceipt:
        if not isinstance(payload, dict):
            raise CleanupExecutionError("Codex cleanup receipt must be a JSON object")
        try:
            status = payload["status"]
            receipt_input = Path(payload["inputFolder"]).resolve()
            raw_outputs = payload["outputFolders"]
            summary = payload["summary"]
            warnings = payload["warnings"]
            checks = payload["checks"]
        except (KeyError, TypeError) as error:
            raise CleanupExecutionError(
                f"Codex cleanup receipt is missing required data: {error}",
            ) from error

        expected_input = input_folder.resolve()
        if receipt_input != expected_input:
            raise CleanupExecutionError(
                f"Codex reported input folder {receipt_input}, expected {expected_input}",
            )
        if status not in {"ready", "needs_review", "failed"}:
            raise CleanupExecutionError(f"Unknown Codex cleanup status {status!r}")
        if not isinstance(raw_outputs, list) or not all(
            isinstance(value, str) for value in raw_outputs
        ):
            raise CleanupExecutionError("outputFolders must be a list of paths")
        if (
            not isinstance(summary, str)
            or not isinstance(warnings, list)
            or not all(isinstance(value, str) for value in warnings)
        ):
            raise CleanupExecutionError(
                "Cleanup summary or warnings have invalid types"
            )
        expected_checks = {
            "archivesTested",
            "metadataValid",
            "imagesFlat",
            "splitComplete",
        }
        if (
            not isinstance(checks, dict)
            or set(checks) != expected_checks
            or not all(isinstance(value, bool) for value in checks.values())
        ):
            raise CleanupExecutionError("Cleanup checks have an invalid shape")

        lexical_outputs = tuple(
            (
                Path(value) if Path(value).is_absolute() else input_folder / value
            ).absolute()
            for value in raw_outputs
        )
        if any(path.is_symlink() for path in lexical_outputs):
            raise CleanupExecutionError("Codex reported a symlinked output folder")
        output_folders = tuple(path.resolve() for path in lexical_outputs)
        if len(set(output_folders)) != len(output_folders):
            raise CleanupExecutionError("Codex reported a duplicate output folder")
        return cls(
            status=status,
            input_folder=receipt_input,
            output_folders=output_folders,
            summary=summary,
            warnings=tuple(warnings),
            checks=dict(checks),
        )

    def as_payload(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "inputFolder": str(self.input_folder),
            "outputFolders": [str(path) for path in self.output_folders],
            "summary": self.summary,
            "warnings": list(self.warnings),
            "checks": dict(self.checks),
        }


@dataclass(frozen=True, slots=True)
class CleanupValidation:
    folders: tuple[ModelFolder, ...]
    errors: tuple[str, ...]

    @property
    def ready(self) -> bool:
        return not self.errors


def find_cleanup_skill() -> Path | None:
    """Find the repository-owned skill from a source checkout."""
    configured = os.getenv("TELEGRAM_CODEX_CLEANUP_SKILL")
    if configured:
        return Path(configured).expanduser().resolve()

    package_file = Path(__file__).resolve()
    candidates = [
        parent / ".agents" / "skills" / "prepare-telegram-staging" / "SKILL.md"
        for parent in package_file.parents
    ]
    return next((path for path in candidates if path.is_file()), None)


def sanitized_codex_environment(
    source: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Pass only shell/config state; saved Codex login supplies authentication."""
    environment = dict(source or os.environ)
    return {
        name: value
        for name, value in environment.items()
        if name in SAFE_ENV_NAMES or name.startswith("LC_")
    }


class CodexCleanupRunner:
    def __init__(
        self,
        *,
        skill_path: Path,
        reference_folder: Path,
        command: str = "codex",
        model: str | None = None,
        timeout_seconds: int = DEFAULT_CLEANUP_TIMEOUT,
        environment: Mapping[str, str] | None = None,
    ) -> None:
        if timeout_seconds < 1:
            raise ValueError("Codex cleanup timeout must be at least one second")
        self.skill_path = skill_path.resolve()
        self.reference_folder = reference_folder.resolve()
        self.command = command
        self.model = model
        self.timeout_seconds = timeout_seconds
        self.environment = sanitized_codex_environment(environment)

    def preflight(self) -> None:
        if not self.skill_path.is_file():
            raise CleanupExecutionError(
                f"Cleanup skill does not exist: {self.skill_path}"
            )
        if not (self.reference_folder / "metadata.json").is_file():
            raise CleanupExecutionError(
                "Cleanup reference must be a folder containing metadata.json: "
                f"{self.reference_folder}",
            )
        if shutil.which(self.command, path=self.environment.get("PATH")) is None:
            raise CleanupExecutionError(
                f"Codex executable {self.command!r} was not found on PATH",
            )

    async def run(
        self,
        *,
        bundle_key: str,
        input_folder: Path,
        work_root: Path,
    ) -> CleanupReceipt:
        self.preflight()
        input_folder = input_folder.resolve()
        if not input_folder.is_dir():
            raise CleanupExecutionError(
                f"Staged input folder is missing: {input_folder}"
            )

        receipt_dir = work_root / "codex-cleanup"
        receipt_dir.mkdir(parents=True, exist_ok=True)
        schema_path = receipt_dir / "cleanup-result.schema.json"
        schema_path.write_text(
            json.dumps(CLEANUP_OUTPUT_SCHEMA, indent=2) + "\n",
            encoding="utf-8",
        )
        receipt_path = receipt_dir / f"{bundle_key}.json"
        receipt_path.unlink(missing_ok=True)

        prompt = self._prompt(input_folder)
        command = [
            self.command,
            "exec",
            "--ephemeral",
            "--skip-git-repo-check",
            "--sandbox",
            "workspace-write",
            "--color",
            "never",
            "-C",
            str(input_folder),
            "--output-schema",
            str(schema_path),
            "--output-last-message",
            str(receipt_path),
        ]
        if self.model:
            command.extend(("--model", self.model))
        command.append(prompt)
        log.info("Handing staged bundle %s to Codex", input_folder.name)
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=self.environment,
                start_new_session=os.name == "posix",
            )
        except OSError as error:
            raise CleanupExecutionError(f"Could not start Codex: {error}") from error

        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=self.timeout_seconds,
            )
        except TimeoutError as error:
            await self._kill(process)
            raise CleanupExecutionError(
                f"Codex cleanup exceeded {self.timeout_seconds} seconds",
            ) from error
        except asyncio.CancelledError:
            await self._kill(process)
            raise

        if process.returncode != 0:
            detail = stderr.decode(errors="replace").strip()
            if not detail:
                detail = stdout.decode(errors="replace").strip()
            if len(detail) > 4000:
                detail = detail[-4000:]
            raise CleanupExecutionError(
                f"Codex cleanup exited with status {process.returncode}: {detail}",
            )
        if not receipt_path.is_file():
            raise CleanupExecutionError(
                "Codex exited without writing a cleanup receipt"
            )
        try:
            payload = json.loads(receipt_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise CleanupExecutionError(
                f"Codex cleanup receipt could not be read: {error}",
            ) from error
        return CleanupReceipt.from_payload(payload, input_folder=input_folder)

    async def _kill(self, process: asyncio.subprocess.Process) -> None:
        try:
            if os.name == "posix":
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
        except ProcessLookupError:
            pass
        await process.wait()

    def _prompt(self, input_folder: Path) -> str:
        return (
            f"Read and follow the skill at {self.skill_path}. "
            f"Prepare only the staged Telegram bundle at {input_folder}. "
            f"Use the completed reference folder at {self.reference_folder}. "
            "Do not edit the reference, the skill, the repository, or any sibling "
            "staging folder. Do not upload anything. If any decision requires human "
            "judgment, return needs_review. Return only the requested structured receipt."
        )


def _inside(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def _read_object(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return None, str(error)
    if not isinstance(payload, dict):
        return None, "must contain a JSON object"
    return payload, None


def _archive_error(path: Path) -> str | None:
    name = path.name.lower()
    try:
        if name.endswith(".zip"):
            with zipfile.ZipFile(path) as archive:
                if corrupt := archive.testzip():
                    return f"contains a corrupt member: {corrupt}"
            return None
        if name.endswith((".tar.gz", ".tgz")):
            with tarfile.open(path, "r:gz") as archive:
                archive.getmembers()
            return None
        seven_zip = shutil.which("7z")
        if not seven_zip:
            return "7z is required to test this archive"
        completed = subprocess.run(
            [seven_zip, "t", "-bso0", "-bsp0", "-y", str(path)],
            capture_output=True,
            text=True,
            timeout=10 * 60,
            check=False,
        )
    except (
        OSError,
        subprocess.TimeoutExpired,
        tarfile.TarError,
        zipfile.BadZipFile,
    ) as error:
        return str(error)
    if completed.returncode != 0:
        return (completed.stderr or completed.stdout).strip() or "7z test failed"
    return None


def _model_folder_errors(
    folder: ModelFolder,
    *,
    reference_metadata: Mapping[str, Any],
    original_source: Mapping[str, Any],
    archive_tester: Callable[[Path], str | None],
) -> list[str]:
    errors: list[str] = []
    path = folder.path
    if path.is_symlink():
        errors.append(f"{path}: model folder must not be a symlink")
    for candidate in path.rglob("*"):
        if candidate.is_symlink():
            errors.append(f"{path}: contains symlink {candidate.relative_to(path)}")

    images_dir = path / "images"
    if not images_dir.is_dir():
        errors.append(f"{path}: images/ is missing")
    elif any(not child.is_file() for child in images_dir.iterdir()):
        errors.append(
            f"{path}: images/ must contain files only, with no subdirectories"
        )

    models_dir = path / "models"
    model_entries = list(models_dir.iterdir()) if models_dir.is_dir() else []
    if len(model_entries) != 1 or not model_entries[0].is_file():
        errors.append(f"{path}: models/ must contain exactly one archive file")
    else:
        archive_path = model_entries[0]
        if not archive_path.name.lower().endswith(SUPPORTED_ARCHIVE_SUFFIXES):
            errors.append(f"{path}: unsupported model archive {archive_path.name}")
        elif archive_error := archive_tester(archive_path):
            errors.append(f"{archive_path}: archive validation failed: {archive_error}")

    metadata_path = path / "metadata.json"
    payload, metadata_error = _read_object(metadata_path)
    if metadata_error or payload is None:
        errors.append(f"{metadata_path}: {metadata_error}")
        return errors
    if set(payload) != set(reference_metadata):
        errors.append(
            f"{metadata_path}: top-level keys do not match the reference metadata",
        )
    nested = payload.get("metadata")
    reference_nested = reference_metadata.get("metadata")
    if not isinstance(nested, dict) or not isinstance(reference_nested, dict):
        errors.append(f"{metadata_path}: metadata must be an object")
    elif extra_keys := set(nested) - set(reference_nested):
        errors.append(
            f"{metadata_path}: nested metadata contains fields not in the reference: "
            + ", ".join(sorted(extra_keys))
        )
    if (
        not isinstance(payload.get("modelName"), str)
        or not payload["modelName"].strip()
    ):
        errors.append(f"{metadata_path}: modelName must be a non-empty string")
    if payload.get("result") is not None:
        errors.append(f"{metadata_path}: result must remain null before upload")

    source = payload.get("source")
    if not isinstance(source, dict):
        errors.append(f"{metadata_path}: Telegram source provenance is missing")
        return errors
    for key in ("channelId", "bundleKey"):
        if source.get(key) != original_source.get(key):
            errors.append(f"{metadata_path}: source.{key} changed during cleanup")
    original_ids = _message_ids(
        original_source.get("modelMessageIds"),
        field="original source.modelMessageIds",
        errors=errors,
        required=True,
    )
    output_ids = _message_ids(
        source.get("modelMessageIds"),
        field=f"{metadata_path}: source.modelMessageIds",
        errors=errors,
        required=True,
    )
    if (
        output_ids is not None
        and original_ids is not None
        and not output_ids.issubset(original_ids)
    ):
        errors.append(f"{metadata_path}: source.modelMessageIds contains unknown IDs")
    original_attachments = _message_ids(
        original_source.get("attachmentMessageIds"),
        field="original source.attachmentMessageIds",
        errors=errors,
    )
    output_attachments = _message_ids(
        source.get("attachmentMessageIds"),
        field=f"{metadata_path}: source.attachmentMessageIds",
        errors=errors,
    )
    if (
        output_attachments is not None
        and original_attachments is not None
        and not output_attachments.issubset(original_attachments)
    ):
        errors.append(
            f"{metadata_path}: source.attachmentMessageIds contains unknown IDs"
        )
    return errors


def _message_ids(
    value: Any,
    *,
    field: str,
    errors: list[str],
    required: bool = False,
) -> set[int] | None:
    if not isinstance(value, list) or any(
        not isinstance(item, int) or isinstance(item, bool) for item in value
    ):
        errors.append(f"{field} must be a list of integer message IDs")
        return None
    if required and not value:
        errors.append(f"{field} must be non-empty")
        return None
    return set(value)


def validate_cleanup_receipt(
    receipt: CleanupReceipt,
    *,
    staging_root: Path,
    original_metadata: Mapping[str, Any],
    reference_folder: Path,
    archive_tester: Callable[[Path], str | None] = _archive_error,
) -> CleanupValidation:
    """Validate Codex's claimed outputs before granting upload authority."""
    errors: list[str] = []
    if receipt.status != "ready":
        return CleanupValidation((), (f"Codex returned {receipt.status}",))
    if not receipt.output_folders:
        return CleanupValidation((), ("Codex returned ready without output folders",))
    if not receipt.input_folder.is_dir():
        return CleanupValidation((), ("The staged input folder no longer exists",))
    for output in receipt.output_folders:
        if not _inside(output, receipt.input_folder):
            errors.append(f"Codex output escapes its assigned bundle: {output}")

    reference_metadata, reference_error = _read_object(
        reference_folder / "metadata.json",
    )
    if reference_error or reference_metadata is None:
        errors.append(f"Reference metadata could not be read: {reference_error}")
        return CleanupValidation((), tuple(errors))
    original_source = original_metadata.get("source")
    if not isinstance(original_source, dict):
        errors.append("Original staged metadata has no Telegram source provenance")
        return CleanupValidation((), tuple(errors))

    found, ambiguous = discover(staging_root)
    found_in_bundle = tuple(
        folder
        for folder in found
        if _inside(folder.path.resolve(), receipt.input_folder)
    )
    ambiguous_in_bundle = [
        (path, reason)
        for path, reason in ambiguous
        if _inside(path.resolve(), receipt.input_folder)
    ]
    for path, reason in ambiguous_in_bundle:
        errors.append(f"{path}: {reason}")

    expected = {path.resolve() for path in receipt.output_folders}
    actual = {folder.path.resolve() for folder in found_in_bundle}
    if expected != actual:
        missing = sorted(str(path) for path in expected - actual)
        unreported = sorted(str(path) for path in actual - expected)
        if missing:
            errors.append(
                "Reported output folders are not uploadable: " + ", ".join(missing)
            )
        if unreported:
            errors.append(
                "Codex left unreported model folders: " + ", ".join(unreported)
            )

    original_model_ids = _message_ids(
        original_source.get("modelMessageIds"),
        field="Original source.modelMessageIds",
        errors=errors,
        required=True,
    )
    covered_model_ids: set[int] = set()
    for folder in found_in_bundle:
        errors.extend(
            _model_folder_errors(
                folder,
                reference_metadata=reference_metadata,
                original_source=original_source,
                archive_tester=archive_tester,
            ),
        )
        payload, _ = _read_object(folder.path / "metadata.json")
        if payload and isinstance(payload.get("source"), dict):
            output_ids = _message_ids(
                payload["source"].get("modelMessageIds"),
                field=f"{folder.path / 'metadata.json'}: source.modelMessageIds",
                errors=errors,
                required=True,
            )
            if output_ids is not None:
                covered_model_ids.update(output_ids)
    if original_model_ids is not None and covered_model_ids != original_model_ids:
        errors.append("Cleaned outputs do not cover every original model message ID")

    return CleanupValidation(found_in_bundle if not errors else (), tuple(errors))
