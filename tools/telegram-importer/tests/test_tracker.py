from __future__ import annotations

import pytest
from alexandria_telegram_importer.tracker import ImportTracker


def discover_record(tracker: ImportTracker, *, import_key: str = "stable-key"):
    return tracker.discover(
        import_key=import_key,
        source_channel_id=-100123,
        logical_filename="dragon.zip",
        upload_filename="tg-100123-stable-dragon.zip",
        model_message_ids=(11, 12),
        attachment_message_ids=(9, 10),
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
