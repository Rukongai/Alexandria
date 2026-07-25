from __future__ import annotations

import pytest
from alexandria_telegram_importer.alexandria import AlexandriaError
from alexandria_telegram_importer.grouping import partition_logical_models
from alexandria_telegram_importer.importer import (
    ChannelImporter,
    CompletionUncertain,
    part_upload_names,
    upload_filename,
)
from alexandria_telegram_importer.tracker import ImportRecord


def test_should_generate_deterministic_names_for_the_same_logical_model(
    media_ref,
) -> None:
    refs = [
        media_ref(102, "dragon.zip.002"),
        media_ref(101, "dragon.zip.001"),
    ]

    [forward] = partition_logical_models(-100987654, refs)
    [reverse] = partition_logical_models(-100987654, reversed(refs))

    assert forward.key == reverse.key
    assert upload_filename(-100987654, forward) == upload_filename(-100987654, reverse)
    assert upload_filename(-100987654, forward).startswith("tg-100987654-")
    assert part_upload_names(-100987654, forward) == (
        f"tg-100987654-{forward.key[:12]}-dragon.zip.001",
        f"tg-100987654-{forward.key[:12]}-dragon.zip.002",
    )


def test_should_remove_stale_crash_downloads_from_dedicated_work_root(tmp_path) -> None:
    work_root = tmp_path / "work"
    stale_directory = work_root / "alexandria-tg-deadbeef-old"
    stale_directory.mkdir(parents=True)
    (stale_directory / "partial-model.rar").write_bytes(b"partial")
    unrelated = work_root / "keep-me"
    unrelated.mkdir()

    importer = ChannelImporter(
        telegram=object(),  # type: ignore[arg-type]
        alexandria=object(),  # type: ignore[arg-type]
        tracker=object(),  # type: ignore[arg-type]
        work_root=work_root,
    )

    importer._cleanup_stale_work()

    assert not stale_directory.exists()
    assert unrelated.exists()


class MissingSessionAlexandria:
    def __init__(self, model_status: str | None) -> None:
        self.model_status = model_status

    async def get_session(self, _session_id: str):
        raise AlexandriaError("missing", status_code=404)

    async def get_model_status(self, model_id: str):
        if self.model_status is None:
            raise AlexandriaError("missing", status_code=404)
        return {"modelId": model_id, "status": self.model_status}


def committing_record() -> ImportRecord:
    return ImportRecord(
        import_key="stable-key",
        source_channel_id=-100123,
        logical_filename="dragon.zip",
        upload_filename="tg-dragon.zip",
        model_message_ids=(1,),
        attachment_message_ids=(),
        status="committing",
        session_id="expired-session",
        model_id="known-model",
        error=None,
    )


@pytest.mark.asyncio
async def test_should_treat_a_ready_known_model_as_completed_when_session_expired() -> (
    None
):
    importer = ChannelImporter(
        telegram=object(),  # type: ignore[arg-type]
        alexandria=MissingSessionAlexandria("ready"),  # type: ignore[arg-type]
        tracker=object(),  # type: ignore[arg-type]
    )

    recovered = await importer._recover_session(committing_record())

    assert recovered == {
        "id": "expired-session",
        "status": "committed",
        "modelId": "known-model",
    }


@pytest.mark.asyncio
async def test_should_refuse_duplicate_when_known_model_cannot_be_verified() -> None:
    importer = ChannelImporter(
        telegram=object(),  # type: ignore[arg-type]
        alexandria=MissingSessionAlexandria(None),  # type: ignore[arg-type]
        tracker=object(),  # type: ignore[arg-type]
    )

    with pytest.raises(CompletionUncertain, match="refusing to create a duplicate"):
        await importer._recover_session(committing_record())
