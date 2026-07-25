from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from filelock import FileLock, Timeout


@dataclass(frozen=True, slots=True)
class ImportRecord:
    import_key: str
    source_channel_id: int
    logical_filename: str
    upload_filename: str
    model_message_ids: tuple[int, ...]
    attachment_message_ids: tuple[int, ...]
    status: str
    session_id: str | None
    model_id: str | None
    error: str | None


class ImportTracker:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._process_lock = FileLock(path.with_name(path.name + ".lock"))
        try:
            self._process_lock.acquire(timeout=0)
        except Timeout as error:
            raise RuntimeError(
                f"Another importer is already using state file {path}"
            ) from error
        self._connection = sqlite3.connect(path)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.execute("PRAGMA synchronous=FULL")
        self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS imports (
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
            """,
        )
        self._connection.commit()

    def close(self) -> None:
        self._connection.close()
        self._process_lock.release()

    def discover(
        self,
        *,
        import_key: str,
        source_channel_id: int,
        logical_filename: str,
        upload_filename: str,
        model_message_ids: tuple[int, ...],
        attachment_message_ids: tuple[int, ...],
    ) -> ImportRecord:
        now = datetime.now(UTC).isoformat()
        with self._connection:
            self._connection.execute(
                """
                INSERT INTO imports (
                    import_key, source_channel_id, logical_filename, upload_filename,
                    model_message_ids, attachment_message_ids, status,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'discovered', ?, ?)
                ON CONFLICT(import_key) DO NOTHING
                """,
                (
                    import_key,
                    source_channel_id,
                    logical_filename,
                    upload_filename,
                    json.dumps(model_message_ids),
                    json.dumps(attachment_message_ids),
                    now,
                    now,
                ),
            )
        record = self.get(import_key)
        assert record is not None
        return record

    def get(self, import_key: str) -> ImportRecord | None:
        row = self._connection.execute(
            "SELECT * FROM imports WHERE import_key = ?",
            (import_key,),
        ).fetchone()
        if row is None:
            return None
        return ImportRecord(
            import_key=row["import_key"],
            source_channel_id=row["source_channel_id"],
            logical_filename=row["logical_filename"],
            upload_filename=row["upload_filename"],
            model_message_ids=tuple(json.loads(row["model_message_ids"])),
            attachment_message_ids=tuple(json.loads(row["attachment_message_ids"])),
            status=row["status"],
            session_id=row["session_id"],
            model_id=row["model_id"],
            error=row["error"],
        )

    def update(
        self,
        import_key: str,
        status: str,
        *,
        session_id: str | None = None,
        model_id: str | None = None,
        error: str | None = None,
    ) -> ImportRecord:
        now = datetime.now(UTC).isoformat()
        with self._connection:
            self._connection.execute(
                """
                UPDATE imports
                SET status = ?,
                    session_id = COALESCE(?, session_id),
                    model_id = COALESCE(?, model_id),
                    error = ?,
                    updated_at = ?
                WHERE import_key = ?
                """,
                (status, session_id, model_id, error, now, import_key),
            )
        record = self.get(import_key)
        if record is None:
            raise KeyError(import_key)
        return record

    def clear_session(
        self, import_key: str, *, status: str, error: str | None = None
    ) -> ImportRecord:
        now = datetime.now(UTC).isoformat()
        with self._connection:
            self._connection.execute(
                """
                UPDATE imports
                SET status = ?, session_id = NULL, model_id = NULL, error = ?, updated_at = ?
                WHERE import_key = ?
                """,
                (status, error, now, import_key),
            )
        record = self.get(import_key)
        if record is None:
            raise KeyError(import_key)
        return record

    def counts(self) -> dict[str, int]:
        rows = self._connection.execute(
            "SELECT status, COUNT(*) AS count FROM imports GROUP BY status",
        ).fetchall()
        return {row["status"]: row["count"] for row in rows}
