from __future__ import annotations

import hashlib

import pytest

from alexandria_telegram_importer.alexandria import AlexandriaError
from alexandria_telegram_importer.grouping import partition_logical_models
from alexandria_telegram_importer.importer import (
    ChannelImporter,
    CompletionUncertain,
    DuplicateModelFound,
    content_signature,
    part_upload_names,
    telegram_media_signature,
    upload_filename,
)
from alexandria_telegram_importer.tracker import ImportRecord, ImportTracker


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


def test_should_generate_order_independent_telegram_and_content_signatures(
    media_ref,
) -> None:
    refs = [
        media_ref(102, "dragon.zip.002", media_identity="document:two:20"),
        media_ref(101, "dragon.zip.001", media_identity="document:one:10"),
    ]
    [forward] = partition_logical_models(-100987654, refs)
    [reverse] = partition_logical_models(-100987654, reversed(refs))
    expected_telegram = hashlib.sha256(
        b"numbered-zip:1\0document:one:10\nnumbered-zip:2\0document:two:20"
    ).hexdigest()

    assert telegram_media_signature(forward) == expected_telegram
    assert telegram_media_signature(reverse) == expected_telegram
    assert (
        content_signature(forward, ["hash-b", "hash-a"])
        == hashlib.sha256(b"numbered-zip:1\0hash-b\nnumbered-zip:2\0hash-a").hexdigest()
    )


def test_should_bind_multipart_hashes_to_their_part_roles(media_ref) -> None:
    [unit] = partition_logical_models(
        -100987654,
        [
            media_ref(101, "dragon.part1.rar"),
            media_ref(102, "dragon.part2.rar"),
        ],
    )

    assert content_signature(unit, ["first-bytes", "second-bytes"]) != (
        content_signature(unit, ["second-bytes", "first-bytes"])
    )
    [swapped_identity_unit] = partition_logical_models(
        -100987654,
        [
            media_ref(
                201,
                "dragon.part1.rar",
                media_identity="document:second:20",
            ),
            media_ref(
                202,
                "dragon.part2.rar",
                media_identity="document:first:10",
            ),
        ],
    )
    [original_identity_unit] = partition_logical_models(
        -100987654,
        [
            media_ref(
                301,
                "dragon.part1.rar",
                media_identity="document:first:10",
            ),
            media_ref(
                302,
                "dragon.part2.rar",
                media_identity="document:second:20",
            ),
        ],
    )

    assert telegram_media_signature(swapped_identity_unit) != telegram_media_signature(
        original_identity_unit
    )


def test_should_withhold_telegram_signature_when_any_part_has_no_identity(
    media_ref,
) -> None:
    [unit] = partition_logical_models(
        -100987654,
        [
            media_ref(101, "dragon.zip.001", media_identity="document:one:10"),
            media_ref(102, "dragon.zip.002"),
        ],
    )

    assert telegram_media_signature(unit) is None
    with pytest.raises(ValueError, match="At least one content hash"):
        content_signature(unit, [])


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


class DedupTelegram:
    channel_id = -100123

    def __init__(self, payloads: dict[int, bytes] | None = None) -> None:
        self.payloads = payloads or {}
        self.download_calls: list[int] = []

    async def download(self, ref, directory):
        self.download_calls.append(ref.message_id)
        if ref.message_id not in self.payloads:
            raise AssertionError("duplicate should have been skipped before download")
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{ref.message_id}_{ref.filename}"
        path.write_bytes(self.payloads[ref.message_id])
        return path

    def message_link(self, _message_id: int):
        return None


class DedupAlexandria:
    def __init__(
        self,
        *,
        missing_model_ids: set[str] | None = None,
        sessions: dict[str, dict] | None = None,
    ):
        self.missing_model_ids = missing_model_ids or set()
        self.sessions = sessions or {}
        self.model_status_calls: list[str] = []
        self.upload_calls: list[str] = []
        self.abort_calls: list[list[str]] = []

    async def get_model_status(self, model_id: str):
        self.model_status_calls.append(model_id)
        if model_id in self.missing_model_ids:
            raise AlexandriaError("missing", status_code=404)
        return {"modelId": model_id, "status": "ready"}

    async def find_session_by_filename(self, _filename: str):
        return None

    async def get_session(self, session_id: str):
        return self.sessions[session_id]

    async def upload_file(self, _path, upload_name: str, *, multipart: bool):
        self.upload_calls.append(upload_name)
        return f"upload-{len(self.upload_calls)}"

    async def complete_upload(self, _upload_ids, *, multipart: bool):
        raise AssertionError("test should not complete the upload")

    async def abort_uploads(self, upload_ids: list[str]):
        self.abort_calls.append(list(upload_ids))


def track_unit(
    tracker: ImportTracker,
    unit,
    *,
    telegram_signature: str | None = None,
):
    return tracker.discover(
        import_key=unit.key,
        source_channel_id=-100123,
        logical_filename=unit.logical_filename,
        upload_filename=upload_filename(-100123, unit),
        model_message_ids=tuple(part.message_id for part in unit.parts),
        attachment_message_ids=(),
        telegram_signature=telegram_signature,
    )


@pytest.mark.asyncio
async def test_should_skip_duplicate_by_telegram_identity_before_download(
    tmp_path,
    media_ref,
) -> None:
    tracker = ImportTracker(tmp_path / "state.sqlite3")
    telegram = DedupTelegram()
    alexandria = DedupAlexandria()
    try:
        [original_unit] = partition_logical_models(
            -100123,
            [media_ref(1, "original.zip", media_identity="document:777:100")],
        )
        original = track_unit(
            tracker,
            original_unit,
            telegram_signature=telegram_media_signature(original_unit),
        )
        original = tracker.update(original.import_key, "completed", model_id="model-1")
        [duplicate_unit] = partition_logical_models(
            -100123,
            [media_ref(2, "forwarded.zip", media_identity="document:777:100")],
        )
        importer = ChannelImporter(
            telegram=telegram,  # type: ignore[arg-type]
            alexandria=alexandria,  # type: ignore[arg-type]
            tracker=tracker,
            work_root=tmp_path / "work",
        )

        await importer._process_unit(duplicate_unit, (), ())

        duplicate = tracker.get(duplicate_unit.key)
        assert duplicate is not None
        assert duplicate.status == "completed"
        assert duplicate.model_id == "model-1"
        assert duplicate.duplicate_of_import_key == original.import_key
        assert telegram.download_calls == []
        assert alexandria.upload_calls == []
    finally:
        tracker.close()


@pytest.mark.parametrize(
    ("status", "recorded_model_id"),
    [("scanning", None), ("committing", "current-model")],
)
@pytest.mark.asyncio
async def test_should_resume_alexandria_progress_before_signature_deduplication(
    tmp_path,
    media_ref,
    status: str,
    recorded_model_id: str | None,
) -> None:
    tracker = ImportTracker(tmp_path / "state.sqlite3")
    signature = "same-telegram-signature"
    alexandria = DedupAlexandria(
        sessions={
            "current-session": {
                "id": "current-session",
                "status": "committed",
                "modelId": "current-model",
            }
        }
    )
    try:
        [original_unit] = partition_logical_models(
            -100123,
            [media_ref(1, "original.zip")],
        )
        original = track_unit(
            tracker,
            original_unit,
            telegram_signature=signature,
        )
        tracker.update(original.import_key, "completed", model_id="older-model")
        [current_unit] = partition_logical_models(
            -100123,
            [media_ref(2, "current.zip")],
        )
        current = track_unit(
            tracker,
            current_unit,
            telegram_signature=signature,
        )
        tracker.update(
            current.import_key,
            status,
            session_id="current-session",
            model_id=recorded_model_id,
        )
        importer = ChannelImporter(
            telegram=DedupTelegram(),  # type: ignore[arg-type]
            alexandria=alexandria,  # type: ignore[arg-type]
            tracker=tracker,
        )

        await importer._process_unit(current_unit, (), ())

        resumed = tracker.get(current.import_key)
        assert resumed is not None
        assert resumed.status == "completed"
        assert resumed.model_id == "current-model"
        assert resumed.duplicate_of_import_key is None
        assert alexandria.model_status_calls == []
    finally:
        tracker.close()


@pytest.mark.asyncio
async def test_should_skip_duplicate_by_sha256_after_download_and_before_upload(
    tmp_path,
    media_ref,
) -> None:
    payload = b"identical archive bytes"
    tracker = ImportTracker(tmp_path / "state.sqlite3")
    telegram = DedupTelegram({2: payload})
    alexandria = DedupAlexandria()
    try:
        [original_unit] = partition_logical_models(
            -100123, [media_ref(1, "original.zip")]
        )
        signature = content_signature(
            original_unit,
            [hashlib.sha256(payload).hexdigest()],
        )
        original = track_unit(tracker, original_unit)
        tracker.set_content_signature(original.import_key, signature)
        original = tracker.update(original.import_key, "completed", model_id="model-1")
        [duplicate_unit] = partition_logical_models(
            -100123,
            [media_ref(2, "renamed.zip", size=len(payload))],
        )
        (tmp_path / "work").mkdir()
        importer = ChannelImporter(
            telegram=telegram,  # type: ignore[arg-type]
            alexandria=alexandria,  # type: ignore[arg-type]
            tracker=tracker,
            work_root=tmp_path / "work",
        )

        await importer._process_unit(duplicate_unit, (), ())

        duplicate = tracker.get(duplicate_unit.key)
        assert duplicate is not None
        assert duplicate.content_signature == signature
        assert duplicate.status == "completed"
        assert duplicate.model_id == "model-1"
        assert duplicate.duplicate_of_import_key == original.import_key
        assert telegram.download_calls == [2]
        assert alexandria.upload_calls == []
    finally:
        tracker.close()


@pytest.mark.asyncio
async def test_should_skip_stale_404_candidate_and_use_later_ready_duplicate(
    tmp_path,
    media_ref,
) -> None:
    tracker = ImportTracker(tmp_path / "state.sqlite3")
    alexandria = DedupAlexandria(missing_model_ids={"deleted-model"})
    try:
        [original_unit] = partition_logical_models(
            -100123, [media_ref(1, "original.zip")]
        )
        original = track_unit(
            tracker, original_unit, telegram_signature="same-signature"
        )
        tracker.update(original.import_key, "completed", model_id="deleted-model")
        [ready_unit] = partition_logical_models(-100123, [media_ref(2, "ready.zip")])
        ready = track_unit(tracker, ready_unit, telegram_signature="same-signature")
        ready = tracker.update(ready.import_key, "completed", model_id="ready-model")
        importer = ChannelImporter(
            telegram=DedupTelegram(),  # type: ignore[arg-type]
            alexandria=alexandria,  # type: ignore[arg-type]
            tracker=tracker,
        )

        duplicate = await importer._find_ready_duplicate(
            "telegram_signature",
            "same-signature",
            exclude_import_key="new-key",
        )

        assert duplicate == ready
        assert alexandria.model_status_calls == ["deleted-model", "ready-model"]
    finally:
        tracker.close()


@pytest.mark.asyncio
async def test_should_abort_first_multipart_upload_when_final_hash_finds_duplicate(
    tmp_path,
    media_ref,
) -> None:
    payloads = {1: b"part one", 2: b"part two"}
    [unit] = partition_logical_models(
        -100123,
        [
            media_ref(1, "dragon.part1.rar", size=len(payloads[1])),
            media_ref(2, "dragon.part2.rar", size=len(payloads[2])),
        ],
    )
    tracker = ImportTracker(tmp_path / "state.sqlite3")
    telegram = DedupTelegram(payloads)
    alexandria = DedupAlexandria()
    try:
        [prior_unit] = partition_logical_models(
            -100123,
            [
                media_ref(10, "prior.part1.rar"),
                media_ref(11, "prior.part2.rar"),
            ],
        )
        prior_signature = content_signature(
            prior_unit,
            [hashlib.sha256(payloads[index]).hexdigest() for index in (1, 2)],
        )
        prior = track_unit(tracker, prior_unit)
        tracker.set_content_signature(prior.import_key, prior_signature)
        prior = tracker.update(prior.import_key, "completed", model_id="model-1")
        track_unit(tracker, unit)
        importer = ChannelImporter(
            telegram=telegram,  # type: ignore[arg-type]
            alexandria=alexandria,  # type: ignore[arg-type]
            tracker=tracker,
        )
        work_dir = tmp_path / "work"

        with pytest.raises(DuplicateModelFound, match=prior.import_key):
            await importer._start_session(unit, work_dir)

        assert telegram.download_calls == [1, 2]
        assert len(alexandria.upload_calls) == 1
        current = tracker.get(unit.key)
        assert current is not None
        assert current.content_signature == prior_signature
        assert alexandria.abort_calls == [["upload-1"]]
        assert list(work_dir.iterdir()) == []
    finally:
        tracker.close()
