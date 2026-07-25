# Telegram Staged Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the Telegram importer into a download phase that stages bundles as folders on disk and an upload phase that ingests folders into Alexandria, with an operator intervention window between them.

**Architecture:** Three new modules in `tools/telegram-importer` — `folder_metadata.py` (pure JSON read/write/merge), `staging.py` (Telegram → folders), `folder_upload.py` (folders → Alexandria). They reuse `TelegramSource`, `AlexandriaClient`, `grouping`, and `progress` directly. `importer.py` and `ChannelImporter` are **not** modified: the existing direct-import path keeps its dedupe, session-recovery, and signature-gate semantics, none of which the staged flow wants.

**Tech Stack:** Python 3.12, `uv`, pytest with `asyncio_mode = "auto"`, SQLite via stdlib `sqlite3`, `httpx`, Telethon.

**Spec:** `docs/superpowers/specs/2026-07-25-telegram-staged-import-design.md`

**Conventions in this codebase you must follow:**
- Test names read `test_should_<behavior>`. See `tests/test_importer.py`.
- All modules start with `from __future__ import annotations`.
- Dataclasses are `@dataclass(frozen=True, slots=True)`.
- Run tests with `uv run pytest` from `tools/telegram-importer`.
- Lint with `uv run ruff check .` from the same directory.
- Commit style is conventional commits: `<type>: <description>`.

**Working directory for every command in this plan:** `tools/telegram-importer`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/alexandria_telegram_importer/folder_metadata.py` (new) | `metadata.json` read/write, inheritance merge, folder-name → model-name |
| `src/alexandria_telegram_importer/staging.py` (new) | Bundle keys, folder naming, downloading a bundle into a folder |
| `src/alexandria_telegram_importer/folder_upload.py` (new) | Discovery walk, `models/` classification, upload/commit, disposal |
| `src/alexandria_telegram_importer/tracker.py` (modify) | `staged_bundles` table and accessors |
| `src/alexandria_telegram_importer/cli.py` (modify) | New flags, mutual exclusion, the pause |
| `tests/test_folder_metadata.py` (new) | Task 1 |
| `tests/test_staging.py` (new) | Tasks 2–4 |
| `tests/test_folder_upload.py` (new) | Tasks 5–8 |
| `tests/test_cli.py` (modify) | Task 9 |

---

## Task 1: Folder metadata read, write, and merge

**Files:**
- Create: `src/alexandria_telegram_importer/folder_metadata.py`
- Test: `tests/test_folder_metadata.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_folder_metadata.py`:

```python
from __future__ import annotations

import json

from alexandria_telegram_importer.folder_metadata import (
    SCHEMA_VERSION,
    batch_metadata,
    merge_chain,
    model_name_from_folder,
    read_metadata,
    write_metadata,
)


def test_should_return_none_for_a_folder_without_metadata(tmp_path) -> None:
    assert read_metadata(tmp_path) is None


def test_should_return_none_for_unparseable_or_non_object_metadata(tmp_path) -> None:
    (tmp_path / "metadata.json").write_text("{not json", encoding="utf-8")
    assert read_metadata(tmp_path) is None

    (tmp_path / "metadata.json").write_text("[1, 2]", encoding="utf-8")
    assert read_metadata(tmp_path) is None


def test_should_round_trip_metadata_preserving_unknown_keys(tmp_path) -> None:
    write_metadata(tmp_path, {"modelName": "Dragon", "somethingNew": {"a": 1}})

    loaded = read_metadata(tmp_path)

    assert loaded["modelName"] == "Dragon"
    assert loaded["somethingNew"] == {"a": 1}
    assert loaded["schemaVersion"] == SCHEMA_VERSION
    assert json.loads((tmp_path / "metadata.json").read_text(encoding="utf-8"))


def test_should_let_the_nearest_level_win_for_scalars() -> None:
    merged = merge_chain(
        [
            {"artist": "Release Studios", "description": "release blurb"},
            {"artist": "Child Studios"},
        ],
    )

    assert merged["artist"] == "Child Studios"
    assert merged["description"] == "release blurb"


def test_should_merge_tags_across_levels_without_duplicates() -> None:
    merged = merge_chain(
        [{"tags": ["dragon", "fantasy"]}, {"tags": ["knight", "dragon"]}],
    )

    assert merged["tags"] == ["dragon", "fantasy", "knight"]


def test_should_merge_metadata_and_options_key_by_key() -> None:
    merged = merge_chain(
        [
            {"metadata": {"scale": "32mm", "license": "personal"}, "options": {"markNsfw": True}},
            {"metadata": {"license": "commercial"}},
        ],
    )

    assert merged["metadata"] == {"scale": "32mm", "license": "commercial"}
    assert merged["options"] == {"markNsfw": True}


def test_should_never_inherit_model_name_from_a_container() -> None:
    merged = merge_chain([{"modelName": "Dragon Set"}, {"artist": "Foo"}])

    assert "modelName" not in merged


def test_should_take_model_name_from_the_leaf_level_only() -> None:
    merged = merge_chain([{"modelName": "Dragon Set"}, {"modelName": "Dragon Knight"}])

    assert merged["modelName"] == "Dragon Knight"


def test_should_ignore_null_values_when_merging() -> None:
    merged = merge_chain([{"artist": "Foo"}, {"artist": None}])

    assert merged["artist"] == "Foo"


def test_should_derive_a_model_name_from_a_staged_folder_name() -> None:
    assert model_name_from_folder("002501-dragon-knight") == "dragon knight"
    assert model_name_from_folder("dragon_knight") == "dragon knight"
    assert model_name_from_folder("123-abc") == "123 abc"


def test_should_strip_non_commit_keys_from_batch_metadata() -> None:
    payload = batch_metadata(
        {
            "modelName": "Dragon",
            "tags": ["a"],
            "schemaVersion": 1,
            "source": {"channelId": -100},
            "result": None,
            "artist": None,
        },
    )

    assert payload == {"modelName": "Dragon", "tags": ["a"]}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_folder_metadata.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'alexandria_telegram_importer.folder_metadata'`

- [ ] **Step 3: Write the implementation**

Create `src/alexandria_telegram_importer/folder_metadata.py`:

```python
from __future__ import annotations

import json
import logging
import re
from collections.abc import Sequence
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

SCHEMA_VERSION = 1
METADATA_FILENAME = "metadata.json"

# Fields the commit endpoint accepts. Kept in sync with
# packages/shared/src/validation/upload.ts batchUploadMetadataSchema.
COMMIT_FIELDS = (
    "modelName",
    "description",
    "collectionId",
    "newCollectionName",
    "artist",
    "tags",
    "metadata",
    "options",
)
_INHERITED_SCALARS = ("description", "collectionId", "newCollectionName", "artist")
_INHERITED_MAPPINGS = ("metadata", "options")

_FOLDER_PREFIX_RE = re.compile(r"^\d{4,}-")


def read_metadata(folder: Path) -> dict[str, Any] | None:
    """Read one folder's metadata.json, or None when it is absent or unusable."""
    path = folder / METADATA_FILENAME
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        log.warning("Ignoring unreadable %s: %s", path, error)
        return None
    if not isinstance(payload, dict):
        log.warning("Ignoring %s: expected a JSON object", path)
        return None
    return payload


def write_metadata(folder: Path, payload: dict[str, Any]) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    document = {"schemaVersion": SCHEMA_VERSION, **payload}
    (folder / METADATA_FILENAME).write_text(
        json.dumps(document, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def merge_chain(chain: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Merge metadata from outermost container to model folder.

    modelName deliberately does not inherit: a release-level name would
    otherwise commit every model in the release under one title.
    """
    merged: dict[str, Any] = {}
    tags: list[str] = []
    for level, payload in enumerate(chain):
        for key in _INHERITED_SCALARS:
            if payload.get(key) is not None:
                merged[key] = payload[key]
        for key in _INHERITED_MAPPINGS:
            value = payload.get(key)
            if isinstance(value, dict):
                merged.setdefault(key, {}).update(value)
        for tag in payload.get("tags") or []:
            if tag not in tags:
                tags.append(tag)
        if level == len(chain) - 1 and payload.get("modelName"):
            merged["modelName"] = payload["modelName"]
    if tags:
        merged["tags"] = tags
    return merged


def batch_metadata(effective: dict[str, Any]) -> dict[str, Any]:
    """Reduce merged metadata to the fields the commit endpoint accepts."""
    return {
        key: effective[key]
        for key in COMMIT_FIELDS
        if effective.get(key) is not None
    }


def model_name_from_folder(name: str) -> str:
    stripped = _FOLDER_PREFIX_RE.sub("", name)
    cleaned = stripped.replace("_", " ").replace("-", " ").strip()
    return cleaned or name
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_folder_metadata.py -v`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add src/alexandria_telegram_importer/folder_metadata.py tests/test_folder_metadata.py
git commit -m "feat: add staged folder metadata read, write, and inheritance merge"
```

---

## Task 2: staged_bundles table on the tracker

**Files:**
- Modify: `src/alexandria_telegram_importer/tracker.py`
- Test: `tests/test_tracker.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_tracker.py`:

```python
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


def test_should_add_the_staged_bundles_table_to_an_existing_state_file(tmp_path) -> None:
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
```

`sqlite3` and `ImportTracker` are already imported at the top of `tests/test_tracker.py`. Verify with `head -20 tests/test_tracker.py` and add any missing import.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_tracker.py -v -k staged`
Expected: FAIL — `AttributeError: 'ImportTracker' object has no attribute 'record_staged'`

- [ ] **Step 3: Write the implementation**

In `src/alexandria_telegram_importer/tracker.py`, add this dataclass immediately after the existing `ImportRecord` dataclass (after line 26):

```python
@dataclass(frozen=True, slots=True)
class StagedBundle:
    bundle_key: str
    source_channel_id: int
    folder_name: str
    model_message_ids: tuple[int, ...]
    status: str
    downloaded_at: str
```

In `ImportTracker.__init__`, insert this immediately before the final `self._connection.commit()` (currently line 85):

```python
        self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS staged_bundles (
                bundle_key TEXT PRIMARY KEY,
                source_channel_id INTEGER NOT NULL,
                folder_name TEXT NOT NULL,
                model_message_ids TEXT NOT NULL,
                status TEXT NOT NULL,
                downloaded_at TEXT NOT NULL
            )
            """,
        )
        self._connection.execute(
            "CREATE INDEX IF NOT EXISTS staged_bundles_channel_idx "
            "ON staged_bundles (source_channel_id)",
        )
```

Add these three methods to `ImportTracker`, immediately before `def counts`:

```python
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
                    model_message_ids, status, downloaded_at
                ) VALUES (?, ?, ?, ?, 'downloaded', ?)
                ON CONFLICT(bundle_key) DO NOTHING
                """,
                (
                    bundle_key,
                    source_channel_id,
                    folder_name,
                    json.dumps(model_message_ids),
                    now,
                ),
            )
        staged = self.get_staged(bundle_key)
        assert staged is not None
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
        )

    def staged_keys(self, source_channel_id: int) -> set[str]:
        rows = self._connection.execute(
            "SELECT bundle_key FROM staged_bundles WHERE source_channel_id = ?",
            (source_channel_id,),
        ).fetchall()
        return {row["bundle_key"] for row in rows}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_tracker.py -v`
Expected: PASS, including the four new tests and every pre-existing one

- [ ] **Step 5: Commit**

```bash
git add src/alexandria_telegram_importer/tracker.py tests/test_tracker.py
git commit -m "feat: track staged Telegram bundles in the importer state file"
```

---

## Task 3: Bundle keys and folder names

**Files:**
- Create: `src/alexandria_telegram_importer/staging.py`
- Test: `tests/test_staging.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_staging.py`:

```python
from __future__ import annotations

from alexandria_telegram_importer.grouping import build_bundles
from alexandria_telegram_importer.models import MediaKind
from alexandria_telegram_importer.staging import bundle_folder_name, bundle_key


def test_should_produce_a_stable_bundle_key_regardless_of_discovery_order(
    media_ref,
) -> None:
    forward = list(
        build_bundles(
            -100987654,
            [media_ref(2501, "dragon-knight.zip"), media_ref(2502, "dragon-mage.zip")],
        ),
    )
    reverse = list(
        build_bundles(
            -100987654,
            [media_ref(2502, "dragon-mage.zip"), media_ref(2501, "dragon-knight.zip")],
        ),
    )

    assert bundle_key(-100987654, forward[0]) == bundle_key(-100987654, reverse[0])


def test_should_produce_different_bundle_keys_for_different_channels(media_ref) -> None:
    [bundle] = build_bundles(-100987654, [media_ref(2501, "dragon.zip")])

    assert bundle_key(-100987654, bundle) != bundle_key(-100111111, bundle)


def test_should_not_collide_with_the_logical_model_key_for_the_same_messages(
    media_ref,
) -> None:
    [bundle] = build_bundles(-100987654, [media_ref(2501, "dragon.zip")])

    assert bundle_key(-100987654, bundle) != bundle.models[0].key


def test_should_name_a_folder_from_the_first_message_id_and_first_model(
    media_ref,
) -> None:
    [bundle] = build_bundles(
        -100987654,
        [
            media_ref(2499, "render.jpg", kind=MediaKind.ATTACHMENT),
            media_ref(2501, "Dragon_Knight Set.zip"),
            media_ref(2502, "dragon-mage.zip"),
        ],
    )

    assert bundle_folder_name(bundle) == "002501-dragon-knight-set"


def test_should_slug_awkward_model_names_into_a_safe_folder_name(media_ref) -> None:
    [bundle] = build_bundles(-100987654, [media_ref(7, "Dragon!!! (v2) [final].zip")])

    assert bundle_folder_name(bundle) == "000007-dragon-v2-final"


def test_should_fall_back_to_the_message_id_when_a_name_slugs_to_nothing(
    media_ref,
) -> None:
    [bundle] = build_bundles(-100987654, [media_ref(7, "!!!.zip")])

    assert bundle_folder_name(bundle) == "000007"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_staging.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'alexandria_telegram_importer.staging'`

- [ ] **Step 3: Write the implementation**

Create `src/alexandria_telegram_importer/staging.py`:

```python
from __future__ import annotations

import hashlib
import re

from .grouping import model_name_from_filename
from .models import ImportBundle

MAX_SLUG_LENGTH = 60

_SLUG_STRIP_RE = re.compile(r"[^a-z0-9]+")


def bundle_message_ids(bundle: ImportBundle) -> tuple[int, ...]:
    return tuple(
        sorted(part.message_id for unit in bundle.models for part in unit.parts)
    )


def bundle_key(channel_id: int, bundle: ImportBundle) -> str:
    """Key one staged bundle.

    The `staged:` prefix keeps this key space disjoint from grouping's
    per-logical-model `import_key`, which hashes the same message IDs.
    """
    ids = ",".join(str(message_id) for message_id in bundle_message_ids(bundle))
    return hashlib.sha256(f"staged:{channel_id}:{ids}".encode()).hexdigest()[:24]


def slug(value: str) -> str:
    return _SLUG_STRIP_RE.sub("-", value.lower()).strip("-")[:MAX_SLUG_LENGTH].strip("-")


def bundle_folder_name(bundle: ImportBundle) -> str:
    # partition_logical_models sorts by first_message_id, so models[0] is earliest.
    first_message_id = min(unit.first_message_id for unit in bundle.models)
    name = slug(model_name_from_filename(bundle.models[0].logical_filename))
    return f"{first_message_id:06d}-{name}" if name else f"{first_message_id:06d}"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_staging.py -v`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/alexandria_telegram_importer/staging.py tests/test_staging.py
git commit -m "feat: add staged bundle keys and folder naming"
```

---

## Task 4: Stage a bundle to disk

**Files:**
- Modify: `src/alexandria_telegram_importer/staging.py`
- Test: `tests/test_staging.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_staging.py`. Add these imports at the top of the file:

```python
import json
from pathlib import Path

from alexandria_telegram_importer.staging import (
    BundleStager,
    bundle_description,
    unique_child,
)
```

Then append:

```python
class FakeTelegram:
    """Stands in for TelegramSource: writes a file named after the ref."""

    def __init__(self, channel_id: int = -100987654, username: str | None = "chan"):
        self.channel_id = channel_id
        self.channel_username = username
        self.downloaded: list[str] = []
        self.fail_on: set[str] = set()

    async def download(self, ref, directory, *, on_progress=None) -> Path:
        if ref.filename in self.fail_on:
            raise RuntimeError(f"boom: {ref.filename}")
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / f"{ref.message_id}_{ref.filename}"
        target.write_bytes(ref.filename.encode())
        self.downloaded.append(ref.filename)
        return target

    def message_link(self, message_id: int) -> str | None:
        if self.channel_username:
            return f"https://t.me/{self.channel_username}/{message_id}"
        return None


def test_should_suffix_a_colliding_folder_name(tmp_path) -> None:
    (tmp_path / "dragon").mkdir()
    (tmp_path / "dragon-2").mkdir()

    assert unique_child(tmp_path, "dragon").name == "dragon-3"
    assert unique_child(tmp_path, "wizard").name == "wizard"


async def test_should_stage_models_and_images_into_their_subfolders(
    tmp_path, media_ref
) -> None:
    [bundle] = build_bundles(
        -100987654,
        [
            media_ref(2499, "render.jpg", kind=MediaKind.ATTACHMENT),
            media_ref(2501, "dragon-knight.zip"),
            media_ref(2502, "dragon-mage.zip"),
        ],
    )
    telegram = FakeTelegram()

    folder = await BundleStager(telegram=telegram, root=tmp_path).stage(bundle)

    assert folder.name == "002501-dragon-knight"
    assert sorted(p.name for p in (folder / "models").iterdir()) == [
        "dragon-knight.zip",
        "dragon-mage.zip",
    ]
    assert [p.name for p in (folder / "images").iterdir()] == ["render.jpg"]
    assert (folder / "models" / "dragon-knight.zip").read_bytes() == b"dragon-knight.zip"


async def test_should_always_create_both_subfolders_even_when_empty(
    tmp_path, media_ref
) -> None:
    [bundle] = build_bundles(-100987654, [media_ref(2501, "dragon.zip")])

    folder = await BundleStager(telegram=FakeTelegram(), root=tmp_path).stage(bundle)

    assert (folder / "models").is_dir()
    assert (folder / "images").is_dir()


async def test_should_write_metadata_with_source_provenance(tmp_path, media_ref) -> None:
    [bundle] = build_bundles(
        -100987654,
        [
            media_ref(2499, "render.jpg", kind=MediaKind.ATTACHMENT, caption="Dragons!"),
            media_ref(2501, "dragon-knight.zip"),
            media_ref(2502, "dragon-mage.zip"),
        ],
    )

    folder = await BundleStager(telegram=FakeTelegram(), root=tmp_path).stage(bundle)
    payload = json.loads((folder / "metadata.json").read_text(encoding="utf-8"))

    assert payload["schemaVersion"] == 1
    assert payload["modelName"] == "dragon knight"
    assert "Dragons!" in payload["description"]
    assert "https://t.me/chan/2501" in payload["description"]
    assert payload["result"] is None
    assert payload["source"]["channelId"] == -100987654
    assert payload["source"]["modelMessageIds"] == [2501, 2502]
    assert payload["source"]["attachmentMessageIds"] == [2499]
    assert payload["source"]["bundleKey"] == bundle_key(-100987654, bundle)


async def test_should_suffix_colliding_filenames_within_a_folder(
    tmp_path, media_ref
) -> None:
    [bundle] = build_bundles(
        -100987654,
        [media_ref(2501, "dragon.zip"), media_ref(2502, "dragon.zip")],
    )

    folder = await BundleStager(telegram=FakeTelegram(), root=tmp_path).stage(bundle)

    assert sorted(p.name for p in (folder / "models").iterdir()) == [
        "dragon-2.zip",
        "dragon.zip",
    ]


async def test_should_remove_the_partial_folder_when_staging_fails(
    tmp_path, media_ref
) -> None:
    [bundle] = build_bundles(
        -100987654,
        [media_ref(2501, "dragon-knight.zip"), media_ref(2502, "dragon-mage.zip")],
    )
    telegram = FakeTelegram()
    telegram.fail_on = {"dragon-mage.zip"}

    with pytest.raises(RuntimeError, match="boom"):
        await BundleStager(telegram=telegram, root=tmp_path).stage(bundle)

    assert list(tmp_path.iterdir()) == []


def test_should_compose_a_bundle_description_from_every_caption(media_ref) -> None:
    [bundle] = build_bundles(
        -100987654,
        [
            media_ref(2499, "a.jpg", kind=MediaKind.ATTACHMENT, caption="First"),
            media_ref(2500, "b.jpg", kind=MediaKind.ATTACHMENT, caption="First"),
            media_ref(2501, "dragon.zip", caption="Second"),
        ],
    )

    description = bundle_description(FakeTelegram(), bundle)

    assert description.count("First") == 1
    assert "Second" in description
    assert "model message(s): 2501" in description
    assert description.endswith("https://t.me/chan/2501")
```

Add `import pytest` to the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_staging.py -v`
Expected: FAIL — `ImportError: cannot import name 'BundleStager'`

- [ ] **Step 3: Write the implementation**

Add to the top of `src/alexandria_telegram_importer/staging.py`:

```python
import logging
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

from .folder_metadata import write_metadata
from .grouping import safe_filename
from .models import ImportBundle, MediaRef
from .progress import ModelProgress, NullModelProgress

log = logging.getLogger(__name__)

MAX_DESCRIPTION_LENGTH = 2000
```

Keep the existing `hashlib`, `re`, `model_name_from_filename`, and `ImportBundle` imports; merge rather than duplicate.

Append to the same file:

```python
class MediaDownloader(Protocol):
    channel_id: int

    async def download(
        self, ref: MediaRef, directory: Path, *, on_progress: Any = None
    ) -> Path: ...

    def message_link(self, message_id: int) -> str | None: ...


def unique_child(parent: Path, name: str) -> Path:
    """A path under parent that does not exist yet, suffixing -2, -3 on collision."""
    candidate = parent / name
    index = 2
    while candidate.exists():
        candidate = parent / f"{name}-{index}"
        index += 1
    return candidate


def _unique_filename(directory: Path, filename: str) -> Path:
    stem, dot, extension = filename.partition(".")
    candidate = directory / filename
    index = 2
    while candidate.exists():
        candidate = directory / f"{stem}-{index}{dot}{extension}"
        index += 1
    return candidate


def bundle_description(source: MediaDownloader, bundle: ImportBundle) -> str:
    """Compose one description for a whole bundle.

    Mirrors importer.build_description, but scoped to every model in the
    bundle rather than one logical model, since a staged folder is a bundle.
    """
    sections: list[str] = []
    seen: set[str] = set()
    parts = [part for unit in bundle.models for part in unit.parts]
    for ref in (*bundle.attachments, *parts):
        if ref.caption and ref.caption not in seen:
            sections.append(ref.caption)
            seen.add(ref.caption)

    ids = ", ".join(str(message_id) for message_id in bundle_message_ids(bundle))
    source_line = (
        f"Imported from Telegram channel {source.channel_id}; model message(s): {ids}."
    )
    first = min(unit.first_message_id for unit in bundle.models)
    if link := source.message_link(first):
        source_line += f" Source: {link}"
    sections.append(source_line)
    description = "\n\n".join(sections)
    if len(description) > MAX_DESCRIPTION_LENGTH:
        return description[: MAX_DESCRIPTION_LENGTH - 1] + "…"
    return description


class BundleStager:
    def __init__(self, *, telegram: MediaDownloader, root: Path) -> None:
        self.telegram = telegram
        self.root = root

    async def stage(
        self, bundle: ImportBundle, handle: ModelProgress | None = None
    ) -> Path:
        """Download one bundle into its own folder, or leave nothing behind."""
        handle = handle or NullModelProgress()
        self.root.mkdir(parents=True, exist_ok=True)
        folder = unique_child(self.root, bundle_folder_name(bundle))
        folder.mkdir()
        try:
            models_dir = folder / "models"
            images_dir = folder / "images"
            models_dir.mkdir()
            images_dir.mkdir()

            parts = [part for unit in bundle.models for part in unit.parts]
            for ref in parts:
                await self._fetch(ref, models_dir, handle)
            for ref in bundle.attachments:
                await self._fetch(ref, images_dir, handle)

            write_metadata(
                folder,
                {
                    "modelName": model_name_from_filename(
                        bundle.models[0].logical_filename
                    ),
                    "description": bundle_description(self.telegram, bundle),
                    "artist": None,
                    "tags": [],
                    "metadata": {},
                    "options": {},
                    "collectionId": None,
                    "newCollectionName": None,
                    "source": {
                        "channelId": self.telegram.channel_id,
                        "channelUsername": getattr(
                            self.telegram, "channel_username", None
                        ),
                        "bundleKey": bundle_key(self.telegram.channel_id, bundle),
                        "modelMessageIds": list(bundle_message_ids(bundle)),
                        "attachmentMessageIds": [
                            ref.message_id for ref in bundle.attachments
                        ],
                        "link": self.telegram.message_link(
                            min(unit.first_message_id for unit in bundle.models)
                        ),
                        "downloadedAt": datetime.now(UTC).isoformat(),
                    },
                    "result": None,
                },
            )
        except BaseException:
            # A half-staged folder would upload as an incomplete model, so the
            # bundle is left entirely unstaged and retried on the next run.
            shutil.rmtree(folder, ignore_errors=True)
            raise
        return folder

    async def _fetch(self, ref: MediaRef, directory: Path, handle: ModelProgress) -> None:
        with handle.transfer("download", ref.filename) as transfer:
            downloaded = await self.telegram.download(
                ref, directory, on_progress=transfer.advance
            )
        target = _unique_filename(directory, safe_filename(ref.filename, "media"))
        downloaded.rename(target)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_staging.py -v`
Expected: PASS, 13 tests

- [ ] **Step 5: Commit**

```bash
git add src/alexandria_telegram_importer/staging.py tests/test_staging.py
git commit -m "feat: stage Telegram bundles into models and images folders"
```

---

## Task 5: Discover model folders and containers

**Files:**
- Create: `src/alexandria_telegram_importer/folder_upload.py`
- Test: `tests/test_folder_upload.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_folder_upload.py`:

```python
from __future__ import annotations

import json
from pathlib import Path

from alexandria_telegram_importer.folder_upload import discover


def make_folder(path: Path, *, models=(), images=(), metadata=None) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    if models:
        (path / "models").mkdir(exist_ok=True)
        for name in models:
            (path / "models" / name).write_bytes(name.encode())
    if images:
        (path / "images").mkdir(exist_ok=True)
        for name in images:
            (path / "images" / name).write_bytes(name.encode())
    if metadata is not None:
        (path / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    return path


def test_should_discover_a_single_model_folder(tmp_path) -> None:
    make_folder(tmp_path / "002501-dragon", models=["dragon.zip"])

    found, ambiguous = discover(tmp_path)

    assert [folder.path.name for folder in found] == ["002501-dragon"]
    assert ambiguous == []


def test_should_recurse_into_a_container_of_model_folders(tmp_path) -> None:
    release = tmp_path / "002501-dragon-set"
    release.mkdir()
    make_folder(release / "knight", models=["knight.zip"])
    make_folder(release / "mage", models=["mage.zip"])

    found, ambiguous = discover(tmp_path)

    assert sorted(folder.path.name for folder in found) == ["knight", "mage"]
    assert ambiguous == []


def test_should_flag_a_parent_that_has_both_models_and_child_model_folders(
    tmp_path,
) -> None:
    release = make_folder(tmp_path / "002501-dragon-set", models=["leftover.zip"])
    make_folder(release / "knight", models=["knight.zip"])

    found, ambiguous = discover(tmp_path)

    assert found == []
    assert [path.name for path, _ in ambiguous] == ["002501-dragon-set"]
    assert "models/" in ambiguous[0][1]


def test_should_skip_the_uploaded_and_failed_directories(tmp_path) -> None:
    make_folder(tmp_path / "pending", models=["a.zip"])
    make_folder(tmp_path / "uploaded" / "done", models=["b.zip"])
    make_folder(tmp_path / "failed" / "broken", models=["c.zip"])

    found, ambiguous = discover(tmp_path)

    assert [folder.path.name for folder in found] == ["pending"]
    assert ambiguous == []


def test_should_build_the_inheritance_chain_from_root_to_leaf(tmp_path) -> None:
    release = tmp_path / "002501-dragon-set"
    release.mkdir()
    (release / "metadata.json").write_text(
        json.dumps({"artist": "Foo Studios", "tags": ["dragon"]}), encoding="utf-8"
    )
    make_folder(
        release / "knight", models=["knight.zip"], metadata={"modelName": "Knight"}
    )

    [folder], _ = discover(tmp_path)

    assert folder.chain[0]["artist"] == "Foo Studios"
    assert folder.chain[-1]["modelName"] == "Knight"
    assert folder.metadata["artist"] == "Foo Studios"
    assert folder.metadata["tags"] == ["dragon"]
    assert folder.metadata["modelName"] == "Knight"


def test_should_collect_container_image_directories(tmp_path) -> None:
    release = tmp_path / "002501-dragon-set"
    release.mkdir()
    (release / "images").mkdir()
    (release / "images" / "group.jpg").write_bytes(b"group")
    make_folder(release / "knight", models=["knight.zip"], images=["knight.jpg"])

    [folder], _ = discover(tmp_path)

    assert [path.name for path in folder.container_image_dirs] == ["images"]
    assert folder.container_image_dirs[0].parent.name == "002501-dragon-set"


def test_should_name_a_model_from_its_folder_when_metadata_is_absent(tmp_path) -> None:
    make_folder(tmp_path / "002501-dragon-knight", models=["a.zip"])

    [folder], _ = discover(tmp_path)

    assert folder.model_name == "dragon knight"


def test_should_prefer_an_explicit_model_name_over_the_folder_name(tmp_path) -> None:
    make_folder(
        tmp_path / "002501-dragon", models=["a.zip"], metadata={"modelName": "Real Name"}
    )

    [folder], _ = discover(tmp_path)

    assert folder.model_name == "Real Name"


def test_should_ignore_a_directory_with_neither_models_nor_subfolders(tmp_path) -> None:
    (tmp_path / "empty").mkdir()
    (tmp_path / "empty" / "notes.txt").write_text("hello", encoding="utf-8")

    found, ambiguous = discover(tmp_path)

    assert found == []
    assert ambiguous == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_folder_upload.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'alexandria_telegram_importer.folder_upload'`

- [ ] **Step 3: Write the implementation**

Create `src/alexandria_telegram_importer/folder_upload.py`:

```python
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
            ModelFolder(
                path=directory, chain=chain, container_image_dirs=image_dirs
            ),
        )
        return

    own_images = directory / IMAGES_DIRNAME
    if own_images.is_dir():
        image_dirs = (*image_dirs, own_images)
    for child in subdirectories:
        _visit(child, chain, image_dirs, found, ambiguous)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_folder_upload.py -v`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/alexandria_telegram_importer/folder_upload.py tests/test_folder_upload.py
git commit -m "feat: discover staged model folders and containers"
```

---

## Task 6: Classify a models/ directory

**Files:**
- Modify: `src/alexandria_telegram_importer/folder_upload.py`
- Test: `tests/test_folder_upload.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_folder_upload.py`. Add `import pytest` and extend the `folder_upload` import to include `ModelsPlan`, `plan_models_dir`, and `build_upload_paths`.

```python
def models_dir(tmp_path: Path, names, subdir_files=()) -> Path:
    target = tmp_path / "models"
    target.mkdir(parents=True, exist_ok=True)
    for name in names:
        (target / name).write_bytes(name.encode())
    for relative in subdir_files:
        path = target / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(relative.encode())
    return target


def test_should_upload_a_lone_archive_as_is(tmp_path) -> None:
    plan = plan_models_dir(models_dir(tmp_path, ["dragon.7z"]))

    assert plan.kind == "as_is"
    assert [path.name for path in plan.paths] == ["dragon.7z"]


def test_should_detect_a_rar_split_set_in_part_order(tmp_path) -> None:
    plan = plan_models_dir(
        models_dir(tmp_path, ["dragon.part2.rar", "dragon.part1.rar"]),
    )

    assert plan.kind == "split"
    assert [path.name for path in plan.paths] == [
        "dragon.part1.rar",
        "dragon.part2.rar",
    ]


def test_should_detect_a_classic_zip_split_set(tmp_path) -> None:
    plan = plan_models_dir(models_dir(tmp_path, ["dragon.z01", "dragon.zip"]))

    assert plan.kind == "split"
    assert [path.name for path in plan.paths] == ["dragon.z01", "dragon.zip"]


def test_should_detect_a_numbered_zip_split_set(tmp_path) -> None:
    plan = plan_models_dir(
        models_dir(tmp_path, ["dragon.zip.001", "dragon.zip.002"]),
    )

    assert plan.kind == "split"


def test_should_zip_an_incomplete_split_set_rather_than_guessing(tmp_path) -> None:
    plan = plan_models_dir(
        models_dir(tmp_path, ["dragon.part1.rar", "dragon.part3.rar"]),
    )

    assert plan.kind == "zip"


def test_should_zip_a_set_that_mixes_two_base_names(tmp_path) -> None:
    plan = plan_models_dir(
        models_dir(tmp_path, ["dragon.part1.rar", "wizard.part2.rar"]),
    )

    assert plan.kind == "zip"


def test_should_zip_an_archive_that_sits_beside_another_file(tmp_path) -> None:
    plan = plan_models_dir(models_dir(tmp_path, ["dragon.7z", "readme.txt"]))

    assert plan.kind == "zip"


def test_should_zip_loose_model_files(tmp_path) -> None:
    plan = plan_models_dir(models_dir(tmp_path, ["knight.stl", "base.stl"]))

    assert plan.kind == "zip"


def test_should_zip_a_lone_subdirectory(tmp_path) -> None:
    plan = plan_models_dir(models_dir(tmp_path, [], subdir_files=["parts/knight.stl"]))

    assert plan.kind == "zip"


def test_should_reject_an_empty_or_missing_models_directory(tmp_path) -> None:
    with pytest.raises(ValueError, match="empty"):
        plan_models_dir(models_dir(tmp_path, []))

    with pytest.raises(ValueError, match="missing"):
        plan_models_dir(tmp_path / "absent")


def test_should_build_a_zip_preserving_paths_relative_to_models(tmp_path) -> None:
    import zipfile

    source = models_dir(tmp_path, ["knight.stl"], subdir_files=["parts/base.stl"])
    work = tmp_path / "work"
    work.mkdir()

    paths, multipart = build_upload_paths(
        plan_models_dir(source), work, "Dragon Knight"
    )

    assert multipart is False
    assert len(paths) == 1
    assert paths[0].name == "Dragon Knight.zip"
    with zipfile.ZipFile(paths[0]) as archive:
        assert sorted(archive.namelist()) == ["knight.stl", "parts/base.stl"]


def test_should_pass_an_as_is_archive_through_without_repacking(tmp_path) -> None:
    source = models_dir(tmp_path, ["dragon.7z"])
    work = tmp_path / "work"
    work.mkdir()

    paths, multipart = build_upload_paths(plan_models_dir(source), work, "Dragon")

    assert multipart is False
    assert paths == (source / "dragon.7z",)
    assert paths[0].read_bytes() == b"dragon.7z"


def test_should_report_a_split_set_as_multipart(tmp_path) -> None:
    source = models_dir(tmp_path, ["dragon.part1.rar", "dragon.part2.rar"])
    work = tmp_path / "work"
    work.mkdir()

    paths, multipart = build_upload_paths(plan_models_dir(source), work, "Dragon")

    assert multipart is True
    assert [path.name for path in paths] == [
        "dragon.part1.rar",
        "dragon.part2.rar",
    ]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_folder_upload.py -v -k plan or upload_paths`
Expected: FAIL — `ImportError: cannot import name 'plan_models_dir'`

- [ ] **Step 3: Write the implementation**

Add these imports to `src/alexandria_telegram_importer/folder_upload.py`:

```python
import zipfile

from .grouping import (
    ARCHIVE_EXTENSIONS,
    multipart_part_role,
    partition_logical_models,
    safe_filename,
    validate_logical_model,
)
from .models import MediaKind, MediaRef
```

Append to the same file:

```python
@dataclass(frozen=True, slots=True)
class ModelsPlan:
    kind: str  # "as_is" | "split" | "zip"
    paths: tuple[Path, ...]


def _is_split_member(filename: str) -> bool:
    try:
        multipart_part_role(filename)
    except ValueError:
        return False
    return True


def _split_order(entries: list[Path]) -> tuple[Path, ...] | None:
    """Order entries as one split set, or None when they are not one.

    Reuses grouping's part detection and validation so the importer and the
    staged flow agree on what a complete set is.
    """
    if len(entries) < 2 or not all(entry.is_file() for entry in entries):
        return None
    if not all(_is_split_member(entry.name) for entry in entries):
        return None
    refs = [
        MediaRef(message_id=index, filename=entry.name, kind=MediaKind.MODEL)
        for index, entry in enumerate(entries)
    ]
    units = partition_logical_models(0, refs)
    if len(units) != 1 or not units[0].multipart:
        return None
    try:
        validate_logical_model(units[0])
    except ValueError as error:
        log.info("Not treating %s as a split set: %s", entries[0].parent, error)
        return None
    order = {part.filename: index for index, part in enumerate(units[0].parts)}
    return tuple(sorted(entries, key=lambda entry: order[entry.name]))


def plan_models_dir(models_dir: Path) -> ModelsPlan:
    if not models_dir.is_dir():
        raise ValueError(f"{models_dir} is missing")
    entries = sorted(models_dir.iterdir())
    if not entries:
        raise ValueError(f"{models_dir} is empty")

    only = entries[0]
    if (
        len(entries) == 1
        and only.is_file()
        and only.name.lower().endswith(ARCHIVE_EXTENSIONS)
    ):
        return ModelsPlan(kind="as_is", paths=(only,))

    if ordered := _split_order(entries):
        return ModelsPlan(kind="split", paths=ordered)

    return ModelsPlan(kind="zip", paths=tuple(entries))


def build_upload_paths(
    plan: ModelsPlan, work_dir: Path, model_name: str
) -> tuple[tuple[Path, ...], bool]:
    """Resolve a plan into paths to upload and whether they are a split set.

    An `as_is` or `split` plan uploads the operator's own files untouched —
    that is what makes hand-made compression worth doing.
    """
    if plan.kind == "as_is":
        return plan.paths, False
    if plan.kind == "split":
        return plan.paths, True

    models_dir = plan.paths[0].parent
    archive_path = work_dir / f"{safe_filename(model_name, 'model')}.zip"
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(models_dir.rglob("*")):
            if path.is_file():
                archive.write(path, arcname=str(path.relative_to(models_dir)))
    return (archive_path,), False
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_folder_upload.py -v`
Expected: PASS, 22 tests

- [ ] **Step 5: Commit**

```bash
git add src/alexandria_telegram_importer/folder_upload.py tests/test_folder_upload.py
git commit -m "feat: classify a staged models directory into an upload plan"
```

---

## Task 7: Dispose of a folder after upload

**Files:**
- Modify: `src/alexandria_telegram_importer/folder_upload.py`
- Test: `tests/test_folder_upload.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_folder_upload.py`, extending the `folder_upload` import with `dispose`.

```python
def test_should_move_a_successful_folder_under_uploaded_preserving_its_path(
    tmp_path,
) -> None:
    release = tmp_path / "002501-dragon-set"
    release.mkdir()
    (release / "metadata.json").write_text(
        json.dumps({"artist": "Foo"}), encoding="utf-8"
    )
    folder = make_folder(release / "knight", models=["knight.zip"])

    destination = dispose(folder, tmp_path, "uploaded", {"modelId": "abc"})

    assert destination == tmp_path / "uploaded" / "002501-dragon-set" / "knight"
    assert (destination / "models" / "knight.zip").is_file()
    assert not folder.exists()


def test_should_copy_container_metadata_alongside_a_disposed_folder(tmp_path) -> None:
    release = tmp_path / "002501-dragon-set"
    release.mkdir()
    (release / "metadata.json").write_text(
        json.dumps({"artist": "Foo"}), encoding="utf-8"
    )
    make_folder(release / "knight", models=["knight.zip"])
    make_folder(release / "mage", models=["mage.zip"])

    dispose(release / "knight", tmp_path, "uploaded", {"modelId": "abc"})

    copied = tmp_path / "uploaded" / "002501-dragon-set" / "metadata.json"
    assert json.loads(copied.read_text(encoding="utf-8"))["artist"] == "Foo"
    assert (release / "metadata.json").is_file()
    assert (release / "mage").is_dir()


def test_should_write_the_result_into_the_disposed_metadata(tmp_path) -> None:
    folder = make_folder(
        tmp_path / "002501-dragon", models=["a.zip"], metadata={"modelName": "Dragon"}
    )

    destination = dispose(folder, tmp_path, "uploaded", {"modelId": "abc"})
    payload = json.loads((destination / "metadata.json").read_text(encoding="utf-8"))

    assert payload["result"] == {"modelId": "abc"}
    assert payload["modelName"] == "Dragon"


def test_should_write_a_result_even_when_the_folder_had_no_metadata(tmp_path) -> None:
    folder = make_folder(tmp_path / "002501-dragon", models=["a.zip"])

    destination = dispose(folder, tmp_path, "failed", {"error": "boom"})
    payload = json.loads((destination / "metadata.json").read_text(encoding="utf-8"))

    assert payload["result"] == {"error": "boom"}


def test_should_remove_a_container_left_with_no_model_folders(tmp_path) -> None:
    release = tmp_path / "002501-dragon-set"
    release.mkdir()
    (release / "metadata.json").write_text(json.dumps({}), encoding="utf-8")
    make_folder(release / "knight", models=["knight.zip"])

    dispose(release / "knight", tmp_path, "uploaded", {"modelId": "abc"})

    assert not release.exists()


def test_should_keep_a_container_that_still_holds_model_folders(tmp_path) -> None:
    release = tmp_path / "002501-dragon-set"
    release.mkdir()
    make_folder(release / "knight", models=["knight.zip"])
    make_folder(release / "mage", models=["mage.zip"])

    dispose(release / "knight", tmp_path, "uploaded", {"modelId": "abc"})

    assert release.is_dir()
    assert (release / "mage").is_dir()


def test_should_suffix_a_disposal_that_collides_with_an_earlier_one(tmp_path) -> None:
    (tmp_path / "uploaded" / "dragon").mkdir(parents=True)
    folder = make_folder(tmp_path / "dragon", models=["a.zip"])

    destination = dispose(folder, tmp_path, "uploaded", {"modelId": "abc"})

    assert destination.name == "dragon-2"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_folder_upload.py -v -k dispose`
Expected: FAIL — `ImportError: cannot import name 'dispose'`

- [ ] **Step 3: Write the implementation**

Add to the imports of `src/alexandria_telegram_importer/folder_upload.py`:

```python
import shutil

from .folder_metadata import METADATA_FILENAME, write_metadata
from .staging import unique_child
```

Merge with the existing `folder_metadata` import rather than duplicating it.

Append to the same file:

```python
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
    """Remove containers that no longer hold any model folder."""
    while directory != root and directory.is_dir():
        remaining, ambiguous = discover(directory)
        if remaining or ambiguous:
            return
        shutil.rmtree(directory, ignore_errors=True)
        directory = directory.parent
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_folder_upload.py -v`
Expected: PASS, 29 tests

- [ ] **Step 5: Commit**

```bash
git add src/alexandria_telegram_importer/folder_upload.py tests/test_folder_upload.py
git commit -m "feat: dispose settled staged folders into uploaded and failed"
```

---

## Task 8: Upload one folder to Alexandria

**Files:**
- Modify: `src/alexandria_telegram_importer/folder_upload.py`
- Test: `tests/test_folder_upload.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_folder_upload.py`, extending the `folder_upload` import with `FolderUploader`.

```python
class FakeAlexandria:
    def __init__(self) -> None:
        self.uploads: list[tuple[str, bool]] = []
        self.appended: list[str] = []
        self.commits: list[dict] = []
        self.session = {"id": "session-1", "status": "ready_for_review"}
        self.fail_commit = False

    async def upload_file(self, path, upload_name, *, multipart, on_progress=None):
        self.uploads.append((upload_name, multipart))
        return f"upload-{len(self.uploads)}"

    async def complete_upload(self, upload_ids, *, multipart):
        return "session-1"

    async def abort_uploads(self, upload_ids) -> None:
        return None

    async def get_session(self, session_id):
        return self.session

    async def wait_for_session(self, session_id, statuses, **kwargs):
        return {"id": session_id, "status": sorted(statuses)[0], "modelId": "model-1"}

    async def append_files(self, session_id, paths, upload_names):
        self.appended.extend(upload_names)
        return self.session

    async def commit(self, session_id, *, model_name, description=None, **extra):
        if self.fail_commit:
            raise RuntimeError("commit exploded")
        self.commits.append(
            {"modelName": model_name, "description": description, **extra}
        )
        return "model-1"


async def test_should_upload_a_folder_and_return_its_model_id(tmp_path) -> None:
    make_folder(
        tmp_path / "002501-dragon",
        models=["dragon.7z"],
        images=["render.jpg"],
        metadata={"modelName": "Dragon", "artist": "Foo", "tags": ["dragon"]},
    )
    alexandria = FakeAlexandria()
    [folder], _ = discover(tmp_path)

    model_id = await FolderUploader(
        alexandria=alexandria, work_root=tmp_path / "work"
    ).upload(folder)

    assert model_id == "model-1"
    assert alexandria.uploads == [("dragon.7z", False)]
    assert alexandria.appended == ["render.jpg"]
    assert alexandria.commits[0]["modelName"] == "Dragon"
    assert alexandria.commits[0]["batch_metadata"]["artist"] == "Foo"
    assert alexandria.commits[0]["batch_metadata"]["tags"] == ["dragon"]


async def test_should_append_container_images_to_every_model_beneath_it(
    tmp_path,
) -> None:
    release = tmp_path / "002501-dragon-set"
    release.mkdir()
    (release / "images").mkdir()
    (release / "images" / "group.jpg").write_bytes(b"group")
    make_folder(release / "knight", models=["knight.zip"], images=["knight.jpg"])
    alexandria = FakeAlexandria()
    [folder], _ = discover(tmp_path)

    await FolderUploader(alexandria=alexandria, work_root=tmp_path / "work").upload(
        folder
    )

    assert sorted(alexandria.appended) == ["group.jpg", "knight.jpg"]


async def test_should_prefer_a_models_own_image_over_a_container_duplicate(
    tmp_path,
) -> None:
    release = tmp_path / "002501-dragon-set"
    release.mkdir()
    (release / "images").mkdir()
    (release / "images" / "render.jpg").write_bytes(b"container")
    make_folder(release / "knight", models=["knight.zip"], images=["render.jpg"])
    alexandria = FakeAlexandria()
    [folder], _ = discover(tmp_path)

    uploader = FolderUploader(alexandria=alexandria, work_root=tmp_path / "work")
    assert [path.read_bytes() for path in uploader.image_paths(folder)] == [b"render.jpg"]


async def test_should_upload_a_split_set_as_multipart(tmp_path) -> None:
    make_folder(
        tmp_path / "002501-dragon", models=["dragon.part1.rar", "dragon.part2.rar"]
    )
    alexandria = FakeAlexandria()
    [folder], _ = discover(tmp_path)

    await FolderUploader(alexandria=alexandria, work_root=tmp_path / "work").upload(
        folder
    )

    assert alexandria.uploads == [
        ("dragon.part1.rar", True),
        ("dragon.part2.rar", True),
    ]


async def test_should_move_a_folder_to_failed_when_upload_raises(tmp_path) -> None:
    make_folder(tmp_path / "002501-dragon", models=["dragon.7z"])
    alexandria = FakeAlexandria()
    alexandria.fail_commit = True

    uploader = FolderUploader(alexandria=alexandria, work_root=tmp_path / "work")
    outcomes = await uploader.run(tmp_path)

    assert outcomes["failed"] == 1
    assert (tmp_path / "failed" / "002501-dragon").is_dir()
    payload = json.loads(
        (tmp_path / "failed" / "002501-dragon" / "metadata.json").read_text(
            encoding="utf-8"
        ),
    )
    assert "commit exploded" in payload["result"]["error"]


async def test_should_move_an_ambiguous_folder_to_failed_without_uploading(
    tmp_path,
) -> None:
    release = make_folder(tmp_path / "002501-dragon-set", models=["leftover.zip"])
    make_folder(release / "knight", models=["knight.zip"])
    alexandria = FakeAlexandria()

    outcomes = await FolderUploader(
        alexandria=alexandria, work_root=tmp_path / "work"
    ).run(tmp_path)

    assert outcomes["failed"] == 1
    assert alexandria.uploads == []
    assert (tmp_path / "failed" / "002501-dragon-set").is_dir()


async def test_should_keep_going_after_one_folder_fails(tmp_path) -> None:
    make_folder(tmp_path / "002501-broken", models=[])
    make_folder(tmp_path / "002502-good", models=["good.7z"])
    alexandria = FakeAlexandria()

    outcomes = await FolderUploader(
        alexandria=alexandria, work_root=tmp_path / "work"
    ).run(tmp_path)

    assert outcomes == {"completed": 1, "failed": 1}
    assert (tmp_path / "uploaded" / "002502-good").is_dir()
    assert (tmp_path / "failed" / "002501-broken").is_dir()
```

Note: `002501-broken` has no `models/` directory, so `discover` treats it as neither a model folder nor a container and skips it. Change that helper call to `make_folder(tmp_path / "002501-broken", models=[])` producing an empty `models/` — update `make_folder` so `models=[]` still creates the directory:

```python
def make_folder(path: Path, *, models=None, images=(), metadata=None) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    if models is not None:
        (path / "models").mkdir(exist_ok=True)
        for name in models:
            (path / "models" / name).write_bytes(name.encode())
    ...
```

Apply that change to the existing `make_folder` at the top of the file; every existing call passes a non-empty list, so their behavior is unchanged.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_folder_upload.py -v -k FolderUploader or uploader`
Expected: FAIL — `ImportError: cannot import name 'FolderUploader'`

- [ ] **Step 3: Write the implementation**

Add to the imports of `src/alexandria_telegram_importer/folder_upload.py`:

```python
import asyncio
import tempfile
from collections import Counter

from .alexandria import session_filenames
from .folder_metadata import batch_metadata
from .progress import (
    ModelProgress,
    NullProgress,
    ProgressReporter,
    guarded_model,
    guarded_reporter,
)
```

Append to the same file:

```python
ATTACHMENT_BATCH_SIZE = 100


class FolderUploader:
    """Uploads hand-curated folders. Performs no deduplication by design:
    the folders are the operator's, and the phases share no state so that
    folders can be split, merged, renamed, and recompressed freely."""

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
        try:
            with guarded_model(self.progress, folder.path.name, parts=1) as handle:
                model_id = await self.upload(folder, handle)
        # One bad folder must not stop the rest of the staging directory.
        except Exception as error:  # noqa: BLE001
            log.error("Failed to upload %s: %s", folder.path.name, error)
            dispose(
                folder.path, root, FAILED_DIRNAME, {"error": str(error), **_failed_at()}
            )
            return "failed"
        dispose(
            folder.path,
            root,
            UPLOADED_DIRNAME,
            {"modelId": model_id, **_uploaded_at()},
        )
        log.info("Uploaded %s as Alexandria model %s", folder.path.name, model_id)
        return "completed"

    async def upload(
        self, folder: ModelFolder, handle: ModelProgress | None = None
    ) -> str:
        handle = handle or NullModelProgress()
        effective = folder.metadata
        payload = batch_metadata(effective)
        payload["modelName"] = folder.model_name

        with tempfile.TemporaryDirectory(
            prefix="alexandria-folder-", dir=self.work_root
        ) as temp:
            plan = plan_models_dir(folder.models_dir)
            if plan.kind == "zip":
                handle.phase("packaging")
            paths, multipart = build_upload_paths(plan, Path(temp), payload["modelName"])

            upload_ids: list[str] = []
            try:
                for path in paths:
                    with handle.transfer("upload", path.name) as transfer:
                        upload_ids.append(
                            await self.alexandria.upload_file(
                                path,
                                path.name,
                                multipart=multipart,
                                on_progress=transfer.advance,
                            ),
                        )
                session_id = await self.alexandria.complete_upload(
                    upload_ids, multipart=multipart
                )
            except Exception:
                await self.alexandria.abort_uploads(upload_ids)
                raise

            handle.phase("scanning")
            session = await self.alexandria.wait_for_session(
                session_id, {"ready_for_review"}
            )
            if session["status"] == "error":
                raise RuntimeError(session.get("error") or "Alexandria ingestion failed")

            await self._append_images(folder, session_id, session, handle)

            handle.phase("committing")
            await self.alexandria.commit(
                session_id,
                model_name=payload.pop("modelName"),
                description=effective.get("description"),
                batch_metadata=payload,
            )
            committed = await self.alexandria.wait_for_session(
                session_id, {"committed"}
            )
            if committed["status"] == "error":
                raise RuntimeError(
                    committed.get("error") or "Alexandria commit failed"
                )
            return committed["modelId"]

    async def _append_images(
        self,
        folder: ModelFolder,
        session_id: str,
        session: dict[str, Any],
        handle: ModelProgress,
    ) -> None:
        present = session_filenames(session)
        pending = tuple(
            path for path in self.image_paths(folder) if path.name not in present
        )
        if not pending:
            return
        handle.phase("attachments")
        done = 0
        handle.attachments(done, len(pending))
        for offset in range(0, len(pending), ATTACHMENT_BATCH_SIZE):
            batch = pending[offset : offset + ATTACHMENT_BATCH_SIZE]
            for path in batch:
                await self.alexandria.append_files(session_id, (path,), (path.name,))
                done += 1
                handle.attachments(done, len(pending))


def _uploaded_at() -> dict[str, str]:
    return {"uploadedAt": datetime.now(UTC).isoformat()}


def _failed_at() -> dict[str, str]:
    return {"failedAt": datetime.now(UTC).isoformat()}
```

Add `from datetime import UTC, datetime` and `NullModelProgress` to the module's imports.

- [ ] **Step 4: Extend AlexandriaClient.commit to carry full batch metadata**

The existing `commit` sends only `modelName` and `description`. Replace `AlexandriaClient.commit` in `src/alexandria_telegram_importer/alexandria.py:261-278` with:

```python
    async def commit(
        self,
        session_id: str,
        *,
        model_name: str,
        description: str | None = None,
        batch_metadata: dict[str, Any] | None = None,
    ) -> str:
        payload: dict[str, Any] = dict(batch_metadata or {})
        payload["modelName"] = model_name[:255]
        if description is not None:
            payload["description"] = description[:2000]
        response = await self._request(
            "POST",
            f"/models/import-sessions/{session_id}/commit",
            json={"batchMetadata": payload},
        )
        return self._data(response)["modelId"]
```

`ChannelImporter` calls `commit(session_id, model_name=..., description=...)`, which this signature still accepts unchanged.

- [ ] **Step 5: Run the whole suite**

Run: `uv run pytest -v`
Expected: PASS — every new test plus every pre-existing one, including `tests/test_importer.py`

- [ ] **Step 6: Commit**

```bash
git add src/alexandria_telegram_importer/folder_upload.py src/alexandria_telegram_importer/alexandria.py tests/test_folder_upload.py
git commit -m "feat: upload staged folders to Alexandria with inherited metadata"
```

---

## Task 9: CLI flags and the pause

**Files:**
- Modify: `src/alexandria_telegram_importer/cli.py`
- Test: `tests/test_cli.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_cli.py`:

```python
def test_should_reject_a_staging_flag_without_a_staging_directory() -> None:
    args = parser().parse_args(["--download-only", "5"])

    with pytest.raises(SystemExit, match="--staging-dir"):
        validate_staging_args(args)


def test_should_reject_a_staging_directory_without_a_staging_flag() -> None:
    args = parser().parse_args(["--staging-dir", "/tmp/work"])

    with pytest.raises(SystemExit, match="one of"):
        validate_staging_args(args)


def test_should_reject_two_staging_flags_at_once() -> None:
    with pytest.raises(SystemExit):
        parser().parse_args(
            ["--staging-dir", "/tmp/work", "--download-only", "5", "--upload-only"],
        )


def test_should_reject_a_non_positive_download_count() -> None:
    with pytest.raises(SystemExit):
        parser().parse_args(["--staging-dir", "/tmp/work", "--download-only", "0"])


def test_should_accept_each_staging_mode(tmp_path) -> None:
    for extra in (["--download-only", "5"], ["--upload-only"], ["--stage", "5"]):
        args = parser().parse_args(["--staging-dir", str(tmp_path), *extra])
        validate_staging_args(args)


def test_should_treat_a_closed_stdin_as_quitting_the_pause(monkeypatch) -> None:
    import io

    monkeypatch.setattr("sys.stdin", io.StringIO(""))

    assert confirm_upload("2 folders staged.") is False


def test_should_treat_q_as_quitting_and_enter_as_proceeding(monkeypatch) -> None:
    import io

    monkeypatch.setattr("sys.stdin", io.StringIO("q\n"))
    assert confirm_upload("2 folders staged.") is False

    monkeypatch.setattr("sys.stdin", io.StringIO("\n"))
    assert confirm_upload("2 folders staged.") is True
```

Add to the top of `tests/test_cli.py`:

```python
import pytest

from alexandria_telegram_importer.cli import confirm_upload, validate_staging_args
```

`parser` is already imported there; verify with `head -15 tests/test_cli.py`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_cli.py -v`
Expected: FAIL — `ImportError: cannot import name 'validate_staging_args'`

- [ ] **Step 3: Write the implementation**

In `src/alexandria_telegram_importer/cli.py`, add this helper beside `_concurrency`:

```python
def _positive(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(
            f"count must be an integer, got {value!r}"
        ) from error
    if parsed < 1:
        raise argparse.ArgumentTypeError("count must be at least 1")
    return parsed
```

In `parser()`, add before `return result`:

```python
    result.add_argument(
        "--staging-dir",
        type=Path,
        default=os.getenv("TELEGRAM_STAGING_DIR") or None,
        help=(
            "Directory holding staged model folders. Required by --download-only, "
            "--upload-only, and --stage"
        ),
    )
    staging = result.add_mutually_exclusive_group()
    staging.add_argument(
        "--download-only",
        type=_positive,
        metavar="N",
        help="Stage up to N new Telegram bundles as folders, then exit",
    )
    staging.add_argument(
        "--upload-only",
        action="store_true",
        help="Upload every model folder already in --staging-dir, then exit",
    )
    staging.add_argument(
        "--stage",
        type=_positive,
        metavar="N",
        help=(
            "Stage up to N new bundles, pause for reorganization, then upload "
            "whatever is in --staging-dir"
        ),
    )
```

Add these two functions at module level:

```python
def validate_staging_args(args: argparse.Namespace) -> None:
    selected = (
        args.download_only is not None or args.upload_only or args.stage is not None
    )
    if selected and args.staging_dir is None:
        raise SystemExit(
            "--staging-dir is required by --download-only, --upload-only, and --stage"
        )
    if args.staging_dir is not None and not selected:
        raise SystemExit(
            "--staging-dir requires one of --download-only, --upload-only, or --stage"
        )


def confirm_upload(summary: str) -> bool:
    """Pause between the phases. A non-interactive stdin quits rather than hangs."""
    print(summary)
    print(
        "Reorganize the folders now — split releases, compress, rename, "
        "edit metadata.json."
    )
    print("Press Enter to upload, or q then Enter to quit without uploading.")
    line = sys.stdin.readline()
    if not line:
        print("No input available; leaving the staged folders in place.")
        return False
    return line.strip().lower() != "q"
```

Add `import sys` to the module's imports.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_cli.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/alexandria_telegram_importer/cli.py tests/test_cli.py
git commit -m "feat: add staged import flags and the reorganization pause"
```

---

## Task 10: Wire the phases into the run loop

**Files:**
- Modify: `src/alexandria_telegram_importer/cli.py`

- [ ] **Step 1: Write the implementation**

Add to the imports of `cli.py`:

```python
from .folder_upload import FolderUploader
from .grouping import build_bundles
from .staging import BundleStager, bundle_key
```

Add these two coroutines at module level:

```python
async def stage_bundles(
    *,
    telegram: TelegramSource,
    tracker: ImportTracker,
    refs: list,
    staging_dir: Path,
    limit: int,
    progress,
) -> tuple[int, int]:
    """Stage up to `limit` not-yet-staged bundles. Returns (staged, failed)."""
    already = tracker.staged_keys(telegram.channel_id)
    stager = BundleStager(telegram=telegram, root=staging_dir)
    staged = 0
    failed = 0
    with guarded_reporter(progress):
        for bundle in build_bundles(telegram.channel_id, refs):
            if staged >= limit:
                break
            key = bundle_key(telegram.channel_id, bundle)
            if key in already:
                continue
            label = bundle.models[0].logical_filename
            try:
                with guarded_model(progress, label, parts=1) as handle:
                    folder = await stager.stage(bundle, handle)
            # One unreachable Telegram post must not stop the rest of the run.
            except Exception as error:  # noqa: BLE001
                log.error("Failed to stage bundle at %s: %s", label, error)
                failed += 1
                continue
            tracker.record_staged(
                bundle_key=key,
                source_channel_id=telegram.channel_id,
                folder_name=folder.name,
                model_message_ids=tuple(
                    part.message_id for unit in bundle.models for part in unit.parts
                ),
            )
            staged += 1
            progress.totals(staged, limit, {"staged": staged, "failed": failed})
    return staged, failed


def _staging_summary(staging_dir: Path, staged: int, failed: int) -> str:
    total_bytes = sum(
        path.stat().st_size for path in staging_dir.rglob("*") if path.is_file()
    )
    line = f"{staged} folders staged in {staging_dir} ({format_bytes(total_bytes)})."
    return line + (f" {failed} bundle(s) failed to stage." if failed else "")
```

Add `format_bytes`, `guarded_model`, and `guarded_reporter` to the `progress` import in `cli.py`, and `log = logging.getLogger(__name__)` at module level.

Replace the body of `run()` between `refs = await telegram.collect_media(...)` and the `finally:` block with:

```python
        if args.dry_run:
            print(describe_plan(telegram.channel_id, refs))
            return 0

        progress = reporter_from_args(
            no_progress=args.no_progress,
            dry_run=args.dry_run,
            verbose=args.verbose,
        )
        staged = failed_to_stage = 0
        if args.download_only is not None or args.stage is not None:
            tracker = ImportTracker(args.state)
            staged, failed_to_stage = await stage_bundles(
                telegram=telegram,
                tracker=tracker,
                refs=refs,
                staging_dir=args.staging_dir,
                limit=args.download_only or args.stage,
                progress=progress,
            )
            summary = _staging_summary(args.staging_dir, staged, failed_to_stage)
            if args.download_only is not None:
                print(summary)
                return 1 if failed_to_stage else 0
            if not confirm_upload(summary):
                return 1 if failed_to_stage else 0

        if args.upload_only or args.stage is not None:
            email = os.getenv("ALEXANDRIA_EMAIL") or input("Alexandria email: ").strip()
            password = os.getenv("ALEXANDRIA_PASSWORD") or getpass.getpass(
                "Alexandria password: "
            )
            alexandria = AlexandriaClient(
                args.alexandria_url,
                library_id=args.library_id,
                poll_interval=args.poll_interval,
                allow_insecure_http=args.allow_insecure_http,
            )
            await alexandria.login(email, password)
            outcomes = await FolderUploader(
                alexandria=alexandria,
                work_root=args.state.parent / f"{args.state.name}.work",
                concurrency=args.concurrency,
                progress=progress,
            ).run(args.staging_dir)
            print(
                "Upload state: "
                + ", ".join(
                    f"{status}={count}" for status, count in sorted(outcomes.items())
                ),
            )
            return 1 if outcomes.get("failed") or failed_to_stage else 0

        email = os.getenv("ALEXANDRIA_EMAIL") or input("Alexandria email: ").strip()
        password = os.getenv("ALEXANDRIA_PASSWORD") or getpass.getpass(
            "Alexandria password: "
        )
        alexandria = AlexandriaClient(
            args.alexandria_url,
            library_id=args.library_id,
            poll_interval=args.poll_interval,
            allow_insecure_http=args.allow_insecure_http,
        )
        await alexandria.login(email, password)
        tracker = tracker or ImportTracker(args.state)
        counts = await ChannelImporter(
            telegram=telegram,
            alexandria=alexandria,
            tracker=tracker,
            work_root=args.state.parent / f"{args.state.name}.work",
            concurrency=args.concurrency,
            progress=progress,
        ).run(refs)
        print(
            "Import state: "
            + ", ".join(f"{status}={count}" for status, count in sorted(counts.items()))
        )
        return (
            1 if counts.get("failed", 0) or counts.get("completion_uncertain", 0) else 0
        )
```

In `main()`, call `validate_staging_args(args)` immediately after `args = parser().parse_args()`.

- [ ] **Step 2: Run the whole suite and lint**

Run: `uv run pytest -v && uv run ruff check .`
Expected: PASS with no lint findings

- [ ] **Step 3: Smoke-test the flags**

Run: `uv run alexandria-telegram-import --help`
Expected: `--staging-dir`, `--download-only`, `--upload-only`, and `--stage` appear

Run: `uv run alexandria-telegram-import --download-only 5`
Expected: exits with `--staging-dir is required by --download-only, --upload-only, and --stage`

- [ ] **Step 4: Commit**

```bash
git add src/alexandria_telegram_importer/cli.py
git commit -m "feat: wire the staged download and folder upload phases into the CLI"
```

---

## Task 11: Document the staged flow

**Files:**
- Modify: `tools/telegram-importer/README.md`

- [ ] **Step 1: Write the documentation**

Insert a new `## Staged import` section immediately after the existing `## Preview and import` section, before `## Concurrency`. It must cover:

- The three flags with a worked example of each, matching Task 9's help text.
- The folder layout (`models/`, `images/`, `metadata.json`) with the tree from the spec.
- The `models/` classification rules — as-is single archive, split set, everything else zipped — and that a hand-made `.7z` is uploaded byte for byte.
- Discovery: `models/` means model folder, subdirectories mean container, both means ambiguous and moved to `failed/`.
- Inheritance: scalars nearest-wins, tags merged, `metadata`/`options` merged per key, `modelName` never inherited.
- Container `images/` appended to every model beneath, with the storage cost stated.
- Disposal into `uploaded/` and `failed/` with `result` written into `metadata.json`.
- That the upload phase performs no deduplication, and that re-uploading a folder moved back out of `uploaded/` creates a second model.
- That `staged_bundles` state makes consecutive `--download-only N` runs walk forward, and that deleting a folder by hand does not re-offer that bundle.

Also add `TELEGRAM_STAGING_DIR` to the `.env` documentation in the Setup section.

- [ ] **Step 2: Verify the documented commands parse**

Run each command shown in the new section with `--help` appended, confirming no argparse error.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document the Telegram staged import flow"
```

---

## Task 12: Full verification and PR

- [ ] **Step 1: Run the full suite, lint, and the repo-wide build**

```bash
uv run pytest -v
uv run ruff check .
```

Then from the repository root:

```bash
npm test
```

Expected: all pass. The npm suite must be unaffected — this plan changes no TypeScript.

- [ ] **Step 2: Confirm the direct-import path still behaves identically**

Run: `uv run pytest tests/test_importer.py tests/test_concurrency.py tests/test_tracker.py -v`
Expected: PASS with no changes to their assertions. If any assertion needed changing, the direct path was modified and that is a defect in this plan's execution — stop and report it.

- [ ] **Step 3: Run the reviewer agent**

Per `CLAUDE.md`, run the `reviewer` agent over the diff for architectural drift and convention violations.

- [ ] **Step 4: Open the PR**

```bash
gh pr create --title "feat: staged Telegram import with an operator reorganization pause" --body "..."
```

The body must summarize the two phases, the folder contract, and the deliberate no-dedupe decision. Do not merge — leave the PR open for review.

---

## Self-Review Notes

Checked against `docs/superpowers/specs/2026-07-25-telegram-staged-import-design.md`:

- Spec §1 command surface → Tasks 9, 10.
- Spec §2 staged download (bundle key, `staged_bundles`, layout, naming, failure) → Tasks 2, 3, 4.
- Spec §3 `metadata.json` → Tasks 1, 4.
- Spec §4 discovery, inheritance, classification, container images, disposal, no-dedupe → Tasks 5, 6, 7, 8.
- Spec §5 backend prefill → **not in this plan.** It is an independent subsystem and has its own plan: `docs/superpowers/plans/2026-07-25-alexandria-metadata-json-prefill.md`.
- Spec §6 module layout → File Structure table.
- Spec §7 testing → the test steps of Tasks 1–8; the backend bullets belong to the other plan.

Naming consistency verified across tasks: `plan_models_dir`, `build_upload_paths`, `ModelsPlan`, `ModelFolder`, `discover`, `dispose`, `FolderUploader`, `BundleStager`, `bundle_key`, `bundle_folder_name`, `unique_child`, `merge_chain`, `batch_metadata`, `model_name_from_folder`, `record_staged`, `get_staged`, `staged_keys`, `validate_staging_args`, `confirm_upload`.

One cross-task dependency to watch: Task 8 Step 4 changes `AlexandriaClient.commit`'s signature. `ChannelImporter` calls it with `model_name=` and `description=` only, both of which the new signature still accepts, so `tests/test_importer.py` must pass unchanged. Task 12 Step 2 verifies this explicitly.
