from __future__ import annotations

import sqlite3

import pytest

from alexandria_telegram_importer.tracker import ImportRecord, ImportTracker


def discover_record(
    tracker: ImportTracker,
    *,
    import_key: str = "stable-key",
    telegram_signature: str | None = None,
):
    return tracker.discover(
        import_key=import_key,
        source_channel_id=-100123,
        logical_filename="dragon.zip",
        upload_filename="tg-100123-stable-dragon.zip",
        model_message_ids=(11, 12),
        attachment_message_ids=(9, 10),
        telegram_signature=telegram_signature,
    )


def test_should_preserve_existing_progress_when_discovery_is_repeated(tmp_path) -> None:
    tracker = ImportTracker(tmp_path / "state.sqlite3")
    try:
        discover_record(tracker)
        completed = tracker.update(
            "stable-key",
            "completed",
            session_id="session-1",
            model_id="model-1",
        )

        rediscovered = tracker.discover(
            import_key="stable-key",
            source_channel_id=-999,
            logical_filename="changed.zip",
            upload_filename="changed-upload.zip",
            model_message_ids=(99,),
            attachment_message_ids=(),
        )

        assert rediscovered == completed
        assert tracker.counts() == {"completed": 1}
    finally:
        tracker.close()


def test_should_persist_one_record_across_tracker_restarts(tmp_path) -> None:
    database_path = tmp_path / "state.sqlite3"
    first = ImportTracker(database_path)
    discover_record(first)
    first.close()

    second = ImportTracker(database_path)
    try:
        rediscovered = discover_record(second)

        assert rediscovered.status == "discovered"
        assert rediscovered.model_message_ids == (11, 12)
        assert rediscovered.attachment_message_ids == (9, 10)
        assert second.counts() == {"discovered": 1}
    finally:
        second.close()


def test_should_clear_stale_session_and_model_state_for_retry(tmp_path) -> None:
    tracker = ImportTracker(tmp_path / "state.sqlite3")
    try:
        discover_record(tracker)
        tracker.update(
            "stable-key",
            "committing",
            session_id="stale-session",
            model_id="stale-model",
            error="old error",
        )

        cleared = tracker.clear_session(
            "stable-key",
            status="failed",
            error="session expired",
        )

        assert cleared.status == "failed"
        assert cleared.session_id is None
        assert cleared.model_id is None
        assert cleared.error == "session expired"
        assert cleared.model_message_ids == (11, 12)
        assert cleared.attachment_message_ids == (9, 10)
    finally:
        tracker.close()


def test_should_reject_a_concurrent_process_using_the_same_state_file(tmp_path) -> None:
    database_path = tmp_path / "state.sqlite3"
    first = ImportTracker(database_path)
    try:
        with pytest.raises(RuntimeError, match="already using state file"):
            ImportTracker(database_path)
    finally:
        first.close()


def test_should_migrate_legacy_schema_and_backfill_signature_on_rediscovery(
    tmp_path,
) -> None:
    database_path = tmp_path / "legacy.sqlite3"
    connection = sqlite3.connect(database_path)
    connection.execute(
        """
        CREATE TABLE imports (
            import_key TEXT PRIMARY KEY,
            source_channel_id INTEGER NOT NULL,
            logical_filename TEXT NOT NULL,
            upload_filename TEXT NOT NULL,
            model_message_ids TEXT NOT NULL,
            attachment_message_ids TEXT NOT NULL,
            status TEXT NOT NULL,
            session_id TEXT,
            model_id TEXT,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    connection.execute(
        """
        INSERT INTO imports VALUES (
            'stable-key', -100123, 'dragon.zip', 'upload.zip', '[11, 12]', '[9]',
            'completed', 'session-1', 'model-1', NULL,
            '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00'
        )
        """
    )
    connection.commit()
    connection.close()

    tracker = ImportTracker(database_path)
    try:
        migrated = tracker.get("stable-key")
        assert migrated is not None
        assert migrated.telegram_signature is None
        assert migrated.content_signature is None
        assert migrated.duplicate_of_import_key is None

        backfilled = discover_record(
            tracker,
            telegram_signature="telegram-signature",
        )

        assert backfilled.status == "completed"
        assert backfilled.model_id == "model-1"
        assert backfilled.telegram_signature == "telegram-signature"
    finally:
        tracker.close()


@pytest.mark.parametrize(
    ("signature_type", "signature"),
    [
        ("telegram_signature", "same-telegram-media"),
        ("content_signature", "same-content"),
    ],
)
def test_should_find_only_completed_modeled_records_by_signature(
    tmp_path,
    signature_type: str,
    signature: str,
) -> None:
    tracker = ImportTracker(tmp_path / "state.sqlite3")
    try:
        discover_record(
            tracker,
            import_key="original",
            telegram_signature=signature
            if signature_type == "telegram_signature"
            else None,
        )
        if signature_type == "content_signature":
            tracker.set_content_signature("original", signature)
        original = tracker.update("original", "completed", model_id="model-1")

        discover_record(
            tracker,
            import_key="unfinished",
            telegram_signature=signature
            if signature_type == "telegram_signature"
            else None,
        )
        if signature_type == "content_signature":
            tracker.set_content_signature("unfinished", signature)
        discover_record(
            tracker,
            import_key="completed-without-model",
            telegram_signature=signature
            if signature_type == "telegram_signature"
            else None,
        )
        if signature_type == "content_signature":
            tracker.set_content_signature("completed-without-model", signature)
        tracker.update("completed-without-model", "completed")

        matches = tracker.completed_by_signature(
            signature_type,
            signature,
            exclude_import_key="new-key",
        )

        assert matches == (original,)
        assert (
            tracker.completed_by_signature(
                signature_type,
                signature,
                exclude_import_key="original",
            )
            == ()
        )
    finally:
        tracker.close()


def test_should_mark_duplicate_as_completed_with_original_model(tmp_path) -> None:
    tracker = ImportTracker(tmp_path / "state.sqlite3")
    try:
        discover_record(tracker, import_key="original")
        original = tracker.update("original", "completed", model_id="model-1")
        discover_record(tracker, import_key="duplicate")
        tracker.update("duplicate", "failed", error="temporary failure")

        duplicate = tracker.mark_duplicate("duplicate", original)

        assert duplicate.status == "completed"
        assert duplicate.model_id == "model-1"
        assert duplicate.duplicate_of_import_key == "original"
        assert duplicate.error is None
    finally:
        tracker.close()


def test_should_refresh_changed_telegram_signature_for_unfinished_import(
    tmp_path,
) -> None:
    tracker = ImportTracker(tmp_path / "state.sqlite3")
    try:
        discover_record(tracker, telegram_signature="old-media")
        tracker.update("stable-key", "failed", error="download failed")

        refreshed = discover_record(tracker, telegram_signature="replacement-media")

        assert refreshed.status == "failed"
        assert refreshed.telegram_signature == "replacement-media"
    finally:
        tracker.close()


def test_should_refuse_to_mark_an_import_with_a_session_as_duplicate(tmp_path) -> None:
    tracker = ImportTracker(tmp_path / "state.sqlite3")
    try:
        discover_record(tracker, import_key="original")
        original = tracker.update("original", "completed", model_id="model-1")
        discover_record(tracker, import_key="in-progress")
        tracker.update("in-progress", "scanning", session_id="session-2")

        with pytest.raises(ValueError, match="Alexandria progress"):
            tracker.mark_duplicate("in-progress", original)
    finally:
        tracker.close()


def test_should_reject_duplicate_source_without_model(tmp_path) -> None:
    tracker = ImportTracker(tmp_path / "state.sqlite3")
    try:
        discover_record(tracker, import_key="duplicate")
        invalid_original = ImportRecord(
            import_key="original",
            source_channel_id=-100123,
            logical_filename="dragon.zip",
            upload_filename="upload.zip",
            model_message_ids=(1,),
            attachment_message_ids=(),
            status="completed",
            session_id=None,
            model_id=None,
            error=None,
        )

        with pytest.raises(ValueError, match="must reference an Alexandria model"):
            tracker.mark_duplicate("duplicate", invalid_original)
    finally:
        tracker.close()


def test_should_record_and_read_back_a_staged_bundle(tmp_path) -> None:
    tracker = ImportTracker(tmp_path / "state.sqlite3")
    try:
        tracker.record_staged(
            bundle_key="abc123",
            source_channel_id=-100987654,
            folder_name="002501-dragon-set",
            model_message_ids=(2501, 2502),
        )

        staged = tracker.get_staged("abc123")

        assert staged is not None
        assert staged.folder_name == "002501-dragon-set"
        assert staged.model_message_ids == (2501, 2502)
        assert staged.status == "downloaded"
        assert staged.downloaded_at
    finally:
        tracker.close()


def test_should_report_staged_keys_for_one_channel_only(tmp_path) -> None:
    tracker = ImportTracker(tmp_path / "state.sqlite3")
    try:
        tracker.record_staged(
            bundle_key="mine",
            source_channel_id=-100987654,
            folder_name="a",
            model_message_ids=(1,),
        )
        tracker.record_staged(
            bundle_key="theirs",
            source_channel_id=-100111111,
            folder_name="b",
            model_message_ids=(2,),
        )

        assert tracker.staged_keys(-100987654) == {"mine"}
    finally:
        tracker.close()


def test_should_treat_recording_the_same_bundle_twice_as_idempotent(tmp_path) -> None:
    tracker = ImportTracker(tmp_path / "state.sqlite3")
    try:
        tracker.record_staged(
            bundle_key="abc123",
            source_channel_id=-100987654,
            folder_name="first",
            model_message_ids=(1,),
        )
        tracker.record_staged(
            bundle_key="abc123",
            source_channel_id=-100987654,
            folder_name="second",
            model_message_ids=(1,),
        )

        staged = tracker.get_staged("abc123")

        assert staged is not None
        assert staged.folder_name == "first"
        assert tracker.staged_keys(-100987654) == {"abc123"}
    finally:
        tracker.close()


def test_should_add_the_staged_bundles_table_to_an_existing_state_file(
    tmp_path,
) -> None:
    path = tmp_path / "state.sqlite3"
    legacy = sqlite3.connect(path)
    legacy.execute(
        "CREATE TABLE imports ("
        "import_key TEXT PRIMARY KEY, source_channel_id INTEGER NOT NULL, "
        "logical_filename TEXT NOT NULL, upload_filename TEXT NOT NULL, "
        "model_message_ids TEXT NOT NULL, attachment_message_ids TEXT NOT NULL, "
        "status TEXT NOT NULL, session_id TEXT, model_id TEXT, error TEXT, "
        "created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    )
    legacy.commit()
    legacy.close()

    tracker = ImportTracker(path)
    try:
        tracker.record_staged(
            bundle_key="abc123",
            source_channel_id=-100987654,
            folder_name="002501-dragon-set",
            model_message_ids=(2501,),
        )

        assert tracker.get_staged("abc123") is not None
    finally:
        tracker.close()


def test_should_persist_cleanup_lifecycle_and_outputs(tmp_path) -> None:
    tracker = ImportTracker(tmp_path / "state.sqlite3")
    try:
        tracker.record_staged(
            bundle_key="abc123",
            source_channel_id=-100987654,
            folder_name="002501-dragon-set",
            model_message_ids=(2501,),
        )

        cleaning = tracker.update_staged_cleanup(
            "abc123",
            status="cleaning",
            report={"originalMetadata": {"source": {"bundleKey": "abc123"}}},
        )
        ready = tracker.update_staged_cleanup(
            "abc123",
            status="ready",
            output_folders=("002501-dragon-set/dragon",),
            report={"status": "ready"},
        )
        committed = tracker.record_staged_committed_output(
            "abc123",
            output_folder="002501-dragon-set/dragon",
            result={"sessionId": "session-1", "modelId": "model-1"},
        )
        uploaded = tracker.update_staged_status("abc123", status="uploaded")

        assert cleaning.cleanup_attempts == 1
        assert ready.output_folders == ("002501-dragon-set/dragon",)
        assert ready.cleanup_report == {"status": "ready"}
        assert committed.status == "committed_cleanup_pending"
        assert committed.cleanup_report == {
            "status": "ready",
            "committedOutputs": {
                "002501-dragon-set/dragon": {
                    "sessionId": "session-1",
                    "modelId": "model-1",
                },
            },
        }
        assert uploaded.status == "uploaded"
        assert tracker.staged_by_status(-100987654, ("uploaded",)) == (uploaded,)
    finally:
        tracker.close()


def test_should_migrate_cleanup_columns_into_an_existing_staged_table(tmp_path) -> None:
    path = tmp_path / "legacy-staged.sqlite3"
    legacy = sqlite3.connect(path)
    legacy.execute(
        "CREATE TABLE staged_bundles ("
        "bundle_key TEXT PRIMARY KEY, source_channel_id INTEGER NOT NULL, "
        "folder_name TEXT NOT NULL, model_message_ids TEXT NOT NULL, "
        "status TEXT NOT NULL, downloaded_at TEXT NOT NULL)",
    )
    legacy.execute(
        "INSERT INTO staged_bundles VALUES "
        "('abc123', -100987654, '002501-dragon', '[2501]', 'downloaded', "
        "'2026-01-01T00:00:00+00:00')",
    )
    legacy.commit()
    legacy.close()

    tracker = ImportTracker(path)
    try:
        staged = tracker.get_staged("abc123")

        assert staged is not None
        assert staged.output_folders == ()
        assert staged.cleanup_attempts == 0
        assert staged.updated_at == staged.downloaded_at
    finally:
        tracker.close()
