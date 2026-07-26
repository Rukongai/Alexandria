from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

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
    telegram_signature: str | None = None
    content_signature: str | None = None
    duplicate_of_import_key: str | None = None


@dataclass(frozen=True, slots=True)
class StagedBundle:
    bundle_key: str
    source_channel_id: int
    folder_name: str
    model_message_ids: tuple[int, ...]
    status: str
    downloaded_at: str
    output_folders: tuple[str, ...] = ()
    cleanup_report: dict[str, Any] | None = None
    cleanup_attempts: int = 0
    updated_at: str | None = None


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
                telegram_signature TEXT,
                content_signature TEXT,
                duplicate_of_import_key TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """,
        )
        existing_columns = {
            row["name"]
            for row in self._connection.execute("PRAGMA table_info(imports)").fetchall()
        }
        for column in (
            "telegram_signature",
            "content_signature",
            "duplicate_of_import_key",
        ):
            if column not in existing_columns:
                self._connection.execute(
                    f"ALTER TABLE imports ADD COLUMN {column} TEXT"
                )
        self._connection.execute(
            "CREATE INDEX IF NOT EXISTS imports_telegram_signature_idx "
            "ON imports (telegram_signature, status)",
        )
        self._connection.execute(
            "CREATE INDEX IF NOT EXISTS imports_content_signature_idx "
            "ON imports (content_signature, status)",
        )
        self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS staged_bundles (
                bundle_key TEXT PRIMARY KEY,
                source_channel_id INTEGER NOT NULL,
                folder_name TEXT NOT NULL,
                model_message_ids TEXT NOT NULL,
                status TEXT NOT NULL,
                downloaded_at TEXT NOT NULL,
                output_folders TEXT NOT NULL DEFAULT '[]',
                cleanup_report TEXT,
                cleanup_attempts INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT
            )
            """,
        )
        staged_columns = {
            row["name"]
            for row in self._connection.execute(
                "PRAGMA table_info(staged_bundles)",
            ).fetchall()
        }
        staged_migrations = {
            "output_folders": "TEXT NOT NULL DEFAULT '[]'",
            "cleanup_report": "TEXT",
            "cleanup_attempts": "INTEGER NOT NULL DEFAULT 0",
            "updated_at": "TEXT",
        }
        for column, declaration in staged_migrations.items():
            if column not in staged_columns:
                self._connection.execute(
                    f"ALTER TABLE staged_bundles ADD COLUMN {column} {declaration}",
                )
        self._connection.execute(
            "UPDATE staged_bundles SET updated_at = downloaded_at "
            "WHERE updated_at IS NULL",
        )
        self._connection.execute(
            "CREATE INDEX IF NOT EXISTS staged_bundles_channel_idx "
            "ON staged_bundles (source_channel_id)",
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
        telegram_signature: str | None = None,
    ) -> ImportRecord:
        now = datetime.now(UTC).isoformat()
        with self._connection:
            self._connection.execute(
                """
                INSERT INTO imports (
                    import_key, source_channel_id, logical_filename, upload_filename,
                    model_message_ids, attachment_message_ids, status,
                    telegram_signature, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?)
                ON CONFLICT(import_key) DO UPDATE SET
                    telegram_signature = CASE
                        WHEN imports.status = 'completed'
                            THEN COALESCE(imports.telegram_signature, excluded.telegram_signature)
                        ELSE excluded.telegram_signature
                    END
                """,
                (
                    import_key,
                    source_channel_id,
                    logical_filename,
                    upload_filename,
                    json.dumps(model_message_ids),
                    json.dumps(attachment_message_ids),
                    telegram_signature,
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
            telegram_signature=row["telegram_signature"],
            content_signature=row["content_signature"],
            duplicate_of_import_key=row["duplicate_of_import_key"],
        )

    def completed_by_signature(
        self,
        signature_type: str,
        signature: str,
        *,
        exclude_import_key: str,
    ) -> tuple[ImportRecord, ...]:
        if signature_type not in {"telegram_signature", "content_signature"}:
            raise ValueError(f"Unsupported signature type: {signature_type}")
        rows = self._connection.execute(
            f"""
            SELECT import_key FROM imports
            WHERE {signature_type} = ?
              AND status = 'completed'
              AND model_id IS NOT NULL
              AND import_key <> ?
            ORDER BY updated_at ASC
            """,
            (signature, exclude_import_key),
        ).fetchall()
        return tuple(
            record
            for row in rows
            if (record := self.get(row["import_key"])) is not None
        )

    def set_content_signature(self, import_key: str, signature: str) -> ImportRecord:
        now = datetime.now(UTC).isoformat()
        with self._connection:
            self._connection.execute(
                "UPDATE imports SET content_signature = ?, updated_at = ? WHERE import_key = ?",
                (signature, now, import_key),
            )
        record = self.get(import_key)
        if record is None:
            raise KeyError(import_key)
        return record

    def mark_duplicate(self, import_key: str, original: ImportRecord) -> ImportRecord:
        if not original.model_id:
            raise ValueError("A duplicate source must reference an Alexandria model")
        now = datetime.now(UTC).isoformat()
        with self._connection:
            result = self._connection.execute(
                """
                UPDATE imports
                SET status = 'completed',
                    model_id = ?,
                    duplicate_of_import_key = ?,
                    error = NULL,
                    updated_at = ?
                WHERE import_key = ?
                  AND status IN ('discovered', 'failed', 'downloading', 'uploading')
                  AND session_id IS NULL
                  AND model_id IS NULL
                """,
                (original.model_id, original.import_key, now, import_key),
            )
        if result.rowcount != 1:
            raise ValueError(
                "Cannot mark an import with Alexandria progress as a duplicate"
            )
        record = self.get(import_key)
        if record is None:
            raise KeyError(import_key)
        return record

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

    def record_staged(
        self,
        *,
        bundle_key: str,
        source_channel_id: int,
        folder_name: str,
        model_message_ids: tuple[int, ...],
    ) -> StagedBundle:
        now = datetime.now(UTC).isoformat()
        with self._connection:
            self._connection.execute(
                """
                INSERT INTO staged_bundles (
                    bundle_key, source_channel_id, folder_name,
                    model_message_ids, status, downloaded_at, updated_at
                ) VALUES (?, ?, ?, ?, 'downloaded', ?, ?)
                ON CONFLICT(bundle_key) DO NOTHING
                """,
                (
                    bundle_key,
                    source_channel_id,
                    folder_name,
                    json.dumps(model_message_ids),
                    now,
                    now,
                ),
            )
        staged = self.get_staged(bundle_key)
        if staged is None:
            raise KeyError(bundle_key)
        return staged

    def get_staged(self, bundle_key: str) -> StagedBundle | None:
        row = self._connection.execute(
            "SELECT * FROM staged_bundles WHERE bundle_key = ?",
            (bundle_key,),
        ).fetchone()
        if row is None:
            return None
        return StagedBundle(
            bundle_key=row["bundle_key"],
            source_channel_id=row["source_channel_id"],
            folder_name=row["folder_name"],
            model_message_ids=tuple(json.loads(row["model_message_ids"])),
            status=row["status"],
            downloaded_at=row["downloaded_at"],
            output_folders=tuple(json.loads(row["output_folders"] or "[]")),
            cleanup_report=(
                json.loads(row["cleanup_report"]) if row["cleanup_report"] else None
            ),
            cleanup_attempts=row["cleanup_attempts"] or 0,
            updated_at=row["updated_at"] or row["downloaded_at"],
        )

    def update_staged_cleanup(
        self,
        bundle_key: str,
        *,
        status: str,
        output_folders: tuple[str, ...] = (),
        report: dict[str, Any] | None = None,
    ) -> StagedBundle:
        allowed = {"cleaning", "ready", "needs_review", "cleanup_failed"}
        if status not in allowed:
            raise ValueError(f"Unsupported staged cleanup status {status!r}")
        now = datetime.now(UTC).isoformat()
        with self._connection:
            result = self._connection.execute(
                """
                UPDATE staged_bundles
                SET status = ?,
                    output_folders = ?,
                    cleanup_report = ?,
                    cleanup_attempts = cleanup_attempts + ?,
                    updated_at = ?
                WHERE bundle_key = ?
                """,
                (
                    status,
                    json.dumps(output_folders),
                    json.dumps(report) if report is not None else None,
                    1 if status == "cleaning" else 0,
                    now,
                    bundle_key,
                ),
            )
        if result.rowcount != 1:
            raise KeyError(bundle_key)
        staged = self.get_staged(bundle_key)
        if staged is None:
            raise KeyError(bundle_key)
        return staged

    def update_staged_status(self, bundle_key: str, *, status: str) -> StagedBundle:
        allowed = {
            "uploading",
            "committed_cleanup_pending",
            "uploaded",
            "upload_failed",
        }
        if status not in allowed:
            raise ValueError(f"Unsupported staged status {status!r}")
        now = datetime.now(UTC).isoformat()
        with self._connection:
            result = self._connection.execute(
                "UPDATE staged_bundles SET status = ?, updated_at = ? "
                "WHERE bundle_key = ?",
                (status, now, bundle_key),
            )
        if result.rowcount != 1:
            raise KeyError(bundle_key)
        staged = self.get_staged(bundle_key)
        if staged is None:
            raise KeyError(bundle_key)
        return staged

    def record_staged_committed_output(
        self,
        bundle_key: str,
        *,
        output_folder: str,
        result: dict[str, Any],
    ) -> StagedBundle:
        """Persist remote commit identity before its local folder is deleted."""
        staged = self.get_staged(bundle_key)
        if staged is None:
            raise KeyError(bundle_key)
        report = dict(staged.cleanup_report or {})
        committed = report.get("committedOutputs")
        if not isinstance(committed, dict):
            committed = {}
        committed[output_folder] = dict(result)
        report["committedOutputs"] = committed
        now = datetime.now(UTC).isoformat()
        with self._connection:
            updated = self._connection.execute(
                """
                UPDATE staged_bundles
                SET status = 'committed_cleanup_pending',
                    cleanup_report = ?,
                    updated_at = ?
                WHERE bundle_key = ?
                """,
                (json.dumps(report), now, bundle_key),
            )
        if updated.rowcount != 1:
            raise KeyError(bundle_key)
        result_record = self.get_staged(bundle_key)
        if result_record is None:
            raise KeyError(bundle_key)
        return result_record

    def staged_by_status(
        self,
        source_channel_id: int,
        statuses: tuple[str, ...],
    ) -> tuple[StagedBundle, ...]:
        if not statuses:
            return ()
        placeholders = ", ".join("?" for _ in statuses)
        rows = self._connection.execute(
            f"SELECT bundle_key FROM staged_bundles "
            f"WHERE source_channel_id = ? AND status IN ({placeholders}) "
            "ORDER BY downloaded_at, bundle_key",
            (source_channel_id, *statuses),
        ).fetchall()
        return tuple(
            staged
            for row in rows
            if (staged := self.get_staged(row["bundle_key"])) is not None
        )

    def staged_keys(self, source_channel_id: int) -> set[str]:
        rows = self._connection.execute(
            "SELECT bundle_key FROM staged_bundles WHERE source_channel_id = ?",
            (source_channel_id,),
        ).fetchall()
        return {row["bundle_key"] for row in rows}

    def counts(self) -> dict[str, int]:
        rows = self._connection.execute(
            "SELECT status, COUNT(*) AS count FROM imports GROUP BY status",
        ).fetchall()
        return {row["status"]: row["count"] for row in rows}
