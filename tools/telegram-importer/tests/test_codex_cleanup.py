from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from alexandria_telegram_importer.codex_cleanup import (
    CleanupReceipt,
    CodexCleanupRunner,
    sanitized_codex_environment,
    validate_cleanup_receipt,
)


def metadata(*, bundle_key: str = "bundle-1") -> dict:
    return {
        "schemaVersion": 1,
        "modelName": "Dragon",
        "description": "A dragon",
        "artist": "Example Artist",
        "tags": ["dragon"],
        "metadata": {"character": "Dragon", "year": 2026},
        "options": {},
        "collectionId": None,
        "newCollectionName": None,
        "source": {
            "channelId": -100123,
            "bundleKey": bundle_key,
            "modelMessageIds": [10, 11],
            "attachmentMessageIds": [8, 9],
        },
        "result": None,
    }


def make_ready_folder(path: Path, payload: dict) -> None:
    (path / "models").mkdir(parents=True)
    (path / "images").mkdir()
    with zipfile.ZipFile(path / "models" / "Dragon.zip", "w") as archive:
        archive.writestr("dragon.stl", b"model")
    (path / "images" / "render.jpg").write_bytes(b"image")
    (path / "metadata.json").write_text(json.dumps(payload), encoding="utf-8")


def receipt(input_folder: Path, *outputs: Path) -> CleanupReceipt:
    return CleanupReceipt(
        status="ready",
        input_folder=input_folder.resolve(),
        output_folders=tuple(path.resolve() for path in outputs),
        summary="prepared",
        warnings=(),
        checks={
            "archivesTested": True,
            "metadataValid": True,
            "imagesFlat": True,
            "splitComplete": True,
        },
    )


def test_should_remove_importer_credentials_from_the_codex_environment() -> None:
    cleaned = sanitized_codex_environment(
        {
            "PATH": "/bin",
            "CODEX_HOME": "/codex",
            "CODEX_API_KEY": "codex-key",
            "TELEGRAM_API_HASH": "telegram-secret",
            "TELEGRAM_PHONE": "+15555555555",
            "ALEXANDRIA_PASSWORD": "alexandria-secret",
            "API_ID": "123",
            "API_HASH": "hash",
            "PHONE": "phone",
        },
    )

    assert cleaned == {
        "PATH": "/bin",
        "CODEX_HOME": "/codex",
    }


def test_should_validate_one_ready_model_folder(tmp_path) -> None:
    staging = tmp_path / "staging"
    model = staging / "002501-dragon"
    original = metadata()
    make_ready_folder(model, original)
    reference = tmp_path / "reference"
    reference.mkdir()
    (reference / "metadata.json").write_text(json.dumps(metadata()), encoding="utf-8")

    validation = validate_cleanup_receipt(
        receipt(model, model),
        staging_root=staging,
        original_metadata=original,
        reference_folder=reference,
    )

    assert validation.ready
    assert [folder.path for folder in validation.folders] == [model]


def test_should_reject_unreported_split_outputs(tmp_path) -> None:
    staging = tmp_path / "staging"
    bundle = staging / "002501-dragons"
    original = metadata()
    first = bundle / "red"
    second = bundle / "blue"
    red = metadata()
    red["source"]["modelMessageIds"] = [10]
    blue = metadata()
    blue["source"]["modelMessageIds"] = [11]
    make_ready_folder(first, red)
    make_ready_folder(second, blue)
    reference = tmp_path / "reference"
    reference.mkdir()
    (reference / "metadata.json").write_text(json.dumps(metadata()), encoding="utf-8")

    validation = validate_cleanup_receipt(
        receipt(bundle, first),
        staging_root=staging,
        original_metadata=original,
        reference_folder=reference,
        archive_tester=lambda path: None,
    )

    assert not validation.ready
    assert any("unreported model folders" in error for error in validation.errors)


def test_should_reject_an_output_outside_the_assigned_bundle(tmp_path) -> None:
    staging = tmp_path / "staging"
    bundle = staging / "002501-dragon"
    outside = staging / "002502-other"
    make_ready_folder(bundle, metadata())
    make_ready_folder(outside, metadata(bundle_key="other"))
    reference = tmp_path / "reference"
    reference.mkdir()
    (reference / "metadata.json").write_text(json.dumps(metadata()), encoding="utf-8")

    validation = validate_cleanup_receipt(
        receipt(bundle, outside),
        staging_root=staging,
        original_metadata=metadata(),
        reference_folder=reference,
        archive_tester=lambda path: None,
    )

    assert not validation.ready
    assert any("escapes its assigned bundle" in error for error in validation.errors)


def test_should_reject_malformed_message_ids_without_crashing(tmp_path) -> None:
    staging = tmp_path / "staging"
    model = staging / "002501-dragon"
    original = metadata()
    malformed = metadata()
    malformed["source"]["modelMessageIds"] = [10, {"unexpected": 11}]
    make_ready_folder(model, malformed)
    reference = tmp_path / "reference"
    reference.mkdir()
    (reference / "metadata.json").write_text(json.dumps(metadata()), encoding="utf-8")

    validation = validate_cleanup_receipt(
        receipt(model, model),
        staging_root=staging,
        original_metadata=original,
        reference_folder=reference,
        archive_tester=lambda path: None,
    )

    assert not validation.ready
    assert any("integer message IDs" in error for error in validation.errors)


def test_should_reject_a_symlinked_output_folder(tmp_path) -> None:
    bundle = tmp_path / "bundle"
    target = bundle / "target"
    make_ready_folder(target, metadata())
    linked = bundle / "linked"
    linked.symlink_to(target, target_is_directory=True)

    with pytest.raises(Exception, match="symlinked output folder"):
        CleanupReceipt.from_payload(
            {
                **receipt(bundle, linked).as_payload(),
                "inputFolder": str(bundle),
                "outputFolders": [str(linked)],
            },
            input_folder=bundle,
        )


async def test_should_run_codex_with_a_schema_and_sanitized_environment(
    monkeypatch,
    tmp_path,
) -> None:
    skill = tmp_path / "SKILL.md"
    skill.write_text("# Prepare", encoding="utf-8")
    reference = tmp_path / "reference"
    reference.mkdir()
    (reference / "metadata.json").write_text(json.dumps(metadata()), encoding="utf-8")
    input_folder = tmp_path / "input"
    input_folder.mkdir()
    captured: dict = {}

    class FakeProcess:
        returncode = 0

        async def communicate(self):
            return b"", b""

        def kill(self) -> None:
            raise AssertionError("process should not be killed")

        async def wait(self) -> int:
            return 0

    async def fake_exec(*command, **kwargs):
        captured["command"] = command
        captured["environment"] = kwargs["env"]
        output = Path(command[command.index("--output-last-message") + 1])
        output.write_text(
            json.dumps(
                {
                    "status": "needs_review",
                    "inputFolder": str(input_folder),
                    "outputFolders": [],
                    "summary": "identity is ambiguous",
                    "warnings": ["choose a character"],
                    "checks": {
                        "archivesTested": False,
                        "metadataValid": False,
                        "imagesFlat": False,
                        "splitComplete": False,
                    },
                },
            ),
            encoding="utf-8",
        )
        return FakeProcess()

    monkeypatch.setattr("asyncio.create_subprocess_exec", fake_exec)
    runner = CodexCleanupRunner(
        skill_path=skill,
        reference_folder=reference,
        command="python3",
        environment={
            "PATH": "/usr/bin:/bin",
            "CODEX_HOME": "/codex",
            "TELEGRAM_API_HASH": "secret",
            "ALEXANDRIA_PASSWORD": "secret",
        },
    )

    result = await runner.run(
        bundle_key="bundle-1",
        input_folder=input_folder,
        work_root=tmp_path / "work",
    )

    assert result.status == "needs_review"
    assert "--ephemeral" in captured["command"]
    assert "--output-schema" in captured["command"]
    assert captured["environment"] == {
        "PATH": "/usr/bin:/bin",
        "CODEX_HOME": "/codex",
    }


def test_should_reject_a_receipt_for_another_input_folder(tmp_path) -> None:
    with pytest.raises(Exception, match="expected"):
        CleanupReceipt.from_payload(
            {
                "status": "failed",
                "inputFolder": str(tmp_path / "wrong"),
                "outputFolders": [],
                "summary": "failed",
                "warnings": [],
                "checks": {
                    "archivesTested": False,
                    "metadataValid": False,
                    "imagesFlat": False,
                    "splitComplete": False,
                },
            },
            input_folder=tmp_path / "expected",
        )
