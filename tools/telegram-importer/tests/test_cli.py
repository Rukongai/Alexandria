from __future__ import annotations

import json
import zipfile
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from alexandria_telegram_importer.cli import (
    confirm_upload,
    parser,
    validate_staging_args,
)
from alexandria_telegram_importer.parallel_download import (
    DEFAULT_CONNECTIONS,
    MAX_CONNECTIONS,
)
from alexandria_telegram_importer.models import MediaKind, MediaRef


def test_should_import_one_model_at_a_time_by_default() -> None:
    assert parser().parse_args([]).concurrency == 1


def test_should_accept_an_explicit_concurrency() -> None:
    assert parser().parse_args(["--concurrency", "4"]).concurrency == 4


def test_should_read_the_default_concurrency_from_the_environment(monkeypatch) -> None:
    monkeypatch.setenv("TELEGRAM_IMPORT_CONCURRENCY", "3")

    assert parser().parse_args([]).concurrency == 3
    assert parser().parse_args(["--concurrency", "1"]).concurrency == 1


@pytest.mark.parametrize("value", ["0", "-2", "many", "1.5"])
def test_should_reject_a_concurrency_that_cannot_run(value: str) -> None:
    with pytest.raises(SystemExit):
        parser().parse_args(["--concurrency", value])


@pytest.mark.parametrize("value", ["0", "many"])
def test_should_reject_an_unusable_concurrency_from_the_environment(
    monkeypatch,
    value: str,
) -> None:
    monkeypatch.setenv("TELEGRAM_IMPORT_CONCURRENCY", value)

    with pytest.raises(SystemExit):
        parser().parse_args([])


def test_should_download_over_several_connections_by_default() -> None:
    assert parser().parse_args([]).download_connections == DEFAULT_CONNECTIONS


def test_should_accept_an_explicit_connection_count() -> None:
    parsed = parser().parse_args(["--download-connections", "4"])

    assert parsed.download_connections == 4


def test_should_allow_disabling_parallel_downloads() -> None:
    assert (
        parser().parse_args(["--download-connections", "1"]).download_connections == 1
    )


def test_should_read_the_default_connection_count_from_the_environment(
    monkeypatch,
) -> None:
    monkeypatch.setenv("TELEGRAM_DOWNLOAD_CONNECTIONS", "6")

    assert parser().parse_args([]).download_connections == 6
    assert (
        parser().parse_args(["--download-connections", "2"]).download_connections == 2
    )


@pytest.mark.parametrize("value", ["0", "-2", "many", "1.5", str(MAX_CONNECTIONS + 1)])
def test_should_reject_a_connection_count_outside_the_usable_range(value: str) -> None:
    with pytest.raises(SystemExit):
        parser().parse_args(["--download-connections", value])


@pytest.mark.parametrize("value", ["0", "many"])
def test_should_reject_an_unusable_connection_count_from_the_environment(
    monkeypatch,
    value: str,
) -> None:
    monkeypatch.setenv("TELEGRAM_DOWNLOAD_CONNECTIONS", value)

    with pytest.raises(SystemExit):
        parser().parse_args([])


def test_should_enable_the_progress_display_by_default() -> None:
    assert parser().parse_args([]).no_progress is False


def test_should_accept_an_explicit_progress_opt_out() -> None:
    assert parser().parse_args(["--no-progress"]).no_progress is True


@pytest.mark.parametrize("value", ["1", "true", "yes"])
def test_should_opt_out_of_progress_from_the_environment(monkeypatch, value) -> None:
    monkeypatch.setenv("TELEGRAM_IMPORT_NO_PROGRESS", value)

    assert parser().parse_args([]).no_progress is True


@pytest.mark.parametrize("value", ["", "0", "false", "no"])
def test_should_keep_progress_for_falsey_environment_values(monkeypatch, value) -> None:
    monkeypatch.setenv("TELEGRAM_IMPORT_NO_PROGRESS", value)

    assert parser().parse_args([]).no_progress is False


def test_should_reject_a_staging_flag_without_a_staging_directory() -> None:
    args = parser().parse_args(["--download-only", "5"])

    with pytest.raises(SystemExit, match="--staging-dir"):
        validate_staging_args(args)


def test_should_stage_the_whole_channel_when_download_only_has_no_count(tmp_path) -> None:
    args = parser().parse_args(["--download-only", "--staging-dir", str(tmp_path)])

    validate_staging_args(args)
    assert args.download_only == 0


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


def test_should_accept_a_message_link_file_for_download_only(tmp_path) -> None:
    links = tmp_path / "links.txt"
    args = parser().parse_args(
        ["--staging-dir", str(tmp_path / "work"), "--download-only", str(links)]
    )

    validate_staging_args(args)
    assert args.download_only == links


def test_should_accept_each_staging_mode(tmp_path) -> None:
    for extra in (["--download-only", "5"], ["--upload-only"], ["--stage", "5"]):
        args = parser().parse_args(["--staging-dir", str(tmp_path), *extra])
        validate_staging_args(args)


def test_should_require_a_reference_for_codex_cleanup(tmp_path) -> None:
    args = parser().parse_args(
        ["--stage", "5", "--cleanup", "codex", "--staging-dir", str(tmp_path)],
    )

    with pytest.raises(SystemExit, match="--cleanup-reference"):
        validate_staging_args(args)


def test_should_accept_codex_cleanup_for_a_staged_import(tmp_path) -> None:
    args = parser().parse_args(
        [
            "--stage",
            "5",
            "--cleanup",
            "codex",
            "--cleanup-reference",
            str(tmp_path / "reference"),
            "--codex-model",
            "gpt-5.4",
            "--codex-reasoning-effort",
            "high",
            "--staging-dir",
            str(tmp_path / "staging"),
        ],
    )

    validate_staging_args(args)
    assert args.cleanup_concurrency == 1
    assert args.cleanup_timeout == 3600
    assert args.codex_model == "gpt-5.4"
    assert args.codex_reasoning_effort == "high"


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


async def test_should_upload_without_touching_telegram(monkeypatch, tmp_path) -> None:
    """--upload-only is local; connecting to Telegram would be wasted work."""
    from alexandria_telegram_importer import cli

    connected: list[str] = []

    class FakeTelegram:
        def __init__(self, **kwargs) -> None:
            pass

        async def connect(self, channel) -> None:
            connected.append("connect")

        async def collect_media(self, *, min_message_id=0):
            connected.append("collect")
            return []

        async def close(self) -> None:
            return None

    class FakeUploader:
        def __init__(self, **kwargs) -> None:
            pass

        async def run(self, root):
            return {"completed": 2}

    class FakeClient:
        async def close(self) -> None:
            return None

    monkeypatch.setenv("TELEGRAM_API_ID", "1")
    monkeypatch.setenv("TELEGRAM_API_HASH", "hash")
    monkeypatch.setattr(cli, "TelegramSource", FakeTelegram)
    monkeypatch.setattr(cli, "FolderUploader", FakeUploader)
    monkeypatch.setattr(cli, "_login", lambda args: _ready(FakeClient()))

    args = parser().parse_args(["--upload-only", "--staging-dir", str(tmp_path)])

    assert await cli.run(args) == 0
    assert connected == []


async def test_should_not_limit_staging_when_download_only_has_no_count(
    monkeypatch, tmp_path
) -> None:
    from alexandria_telegram_importer import cli

    limits: list[int | None] = []

    class FakeTelegram:
        channel_id = -100123

        def __init__(self, **kwargs) -> None:
            pass

        async def connect(self, channel) -> None:
            return None

        async def collect_media(self, *, min_message_id=0):
            return []

        async def close(self) -> None:
            return None

    async def fake_stage_bundles(**kwargs):
        limits.append(kwargs["limit"])
        return cli.StagingResult((), (), 0)

    monkeypatch.setenv("TELEGRAM_API_ID", "1")
    monkeypatch.setenv("TELEGRAM_API_HASH", "hash")
    monkeypatch.setattr(cli, "TelegramSource", FakeTelegram)
    monkeypatch.setattr(cli, "stage_bundles", fake_stage_bundles)
    args = parser().parse_args(
        [
            "--download-only",
            "--staging-dir",
            str(tmp_path / "staging"),
            "--state",
            str(tmp_path / "state.sqlite3"),
        ]
    )

    assert await cli.run(args) == 0
    assert limits == [None]


async def test_should_stage_every_pending_bundle_when_limit_is_omitted(
    monkeypatch, tmp_path
) -> None:
    from alexandria_telegram_importer import cli
    from alexandria_telegram_importer.progress import NullProgress

    recorded: list[dict] = []

    class FakeTracker:
        def staged_keys(self, channel_id):
            return set()

        def record_staged(self, **kwargs):
            recorded.append(kwargs)
            return SimpleNamespace(folder_name=kwargs["folder_name"])

    class FakeStager:
        def __init__(self, *, telegram, root) -> None:
            self.root = root

        async def stage(self, bundle, handle):
            folder = self.root / str(bundle.models[0].first_message_id)
            folder.mkdir(parents=True)
            return folder

    monkeypatch.setattr(cli, "BundleStager", FakeStager)
    result = await cli.stage_bundles(
        telegram=SimpleNamespace(channel_id=-100123),
        tracker=FakeTracker(),
        refs=[
            MediaRef(1, "first.zip", MediaKind.MODEL),
            MediaRef(2, "preview.jpg", MediaKind.ATTACHMENT),
            MediaRef(3, "second.zip", MediaKind.MODEL),
        ],
        staging_dir=tmp_path / "staging",
        limit=None,
        progress=NullProgress(),
    )

    assert [item["model_message_ids"] for item in recorded] == [(1,), (3,)]
    assert len(result.items) == 2


async def test_should_stage_only_messages_selected_by_links(
    monkeypatch, tmp_path
) -> None:
    from alexandria_telegram_importer import cli

    links = tmp_path / "links.txt"
    links.write_text(
        "https://t.me/first/30\n"
        "https://t.me/first/10\n"
        "https://t.me/c/123/20\n",
        encoding="utf-8",
    )
    selections: list[tuple[str | int, tuple[int, ...]]] = []
    staged_refs: list[tuple[int, ...]] = []

    class FakeTelegram:
        channel_id = 0
        channel_username = None

        def __init__(self, **kwargs) -> None:
            pass

        async def connect(self, channel) -> None:
            self.channel_id = -1001
            self.channel_username = "first"
            selections.append((channel, ()))

        async def select_channel(self, channel) -> None:
            self.channel_id = channel
            self.channel_username = None
            selections.append((channel, ()))

        async def collect_media_by_ids(self, message_ids):
            channel, _ = selections[-1]
            selections[-1] = (channel, message_ids)
            return (
                [
                    MediaRef(
                        message_id=message_id,
                        filename=f"model-{message_id}.zip",
                        kind=MediaKind.MODEL,
                    )
                    for message_id in message_ids
                ],
                (),
            )

        def message_link(self, message_id):
            return f"https://t.me/source/{message_id}"

        async def close(self) -> None:
            return None

    async def fake_stage_bundles(**kwargs):
        staged_refs.append(tuple(ref.message_id for ref in kwargs["refs"]))
        return cli.StagingResult((), (), 100)

    monkeypatch.setenv("TELEGRAM_API_ID", "1")
    monkeypatch.setenv("TELEGRAM_API_HASH", "hash")
    monkeypatch.setattr(cli, "TelegramSource", FakeTelegram)
    monkeypatch.setattr(cli, "stage_bundles", fake_stage_bundles)

    args = parser().parse_args(
        [
            "--download-only",
            str(links),
            "--staging-dir",
            str(tmp_path / "staging"),
            "--state",
            str(tmp_path / "state.sqlite3"),
        ]
    )

    assert await cli.run(args) == 0
    assert selections == [("@first", (10, 30)), (-100123, (20,))]
    assert staged_refs == [(10,), (30,), (20,)]


async def test_should_reject_changed_attachments_for_an_existing_staged_bundle(
    monkeypatch, tmp_path
) -> None:
    from alexandria_telegram_importer import cli
    from alexandria_telegram_importer.grouping import build_bundles
    from alexandria_telegram_importer.staging import bundle_key
    from alexandria_telegram_importer.tracker import ImportTracker

    state = tmp_path / "state.sqlite3"
    model = MediaRef(message_id=10, filename="dragon.zip", kind=MediaKind.MODEL)
    bundle = next(build_bundles(-1001, [model]))
    tracker = ImportTracker(state)
    try:
        tracker.record_staged(
            bundle_key=bundle_key(-1001, bundle),
            source_channel_id=-1001,
            folder_name="000010-dragon",
            model_message_ids=(10,),
            attachment_message_ids=(),
        )
    finally:
        tracker.close()

    links = tmp_path / "links.txt"
    links.write_text(
        "https://t.me/first/9\nhttps://t.me/first/10\n",
        encoding="utf-8",
    )

    class FakeTelegram:
        channel_id = -1001
        channel_username = "first"

        def __init__(self, **kwargs) -> None:
            pass

        async def connect(self, channel) -> None:
            assert channel == "@first"

        async def collect_media_by_ids(self, message_ids):
            assert message_ids == (9, 10)
            return (
                [
                    MediaRef(
                        message_id=9,
                        filename="render.jpg",
                        kind=MediaKind.ATTACHMENT,
                    ),
                    model,
                ],
                (),
            )

        def message_link(self, message_id):
            return f"https://t.me/first/{message_id}"

        async def download(self, *args, **kwargs):
            raise AssertionError("an already-staged bundle must not download again")

        async def close(self) -> None:
            return None

    monkeypatch.setenv("TELEGRAM_API_ID", "1")
    monkeypatch.setenv("TELEGRAM_API_HASH", "hash")
    monkeypatch.setattr(cli, "TelegramSource", FakeTelegram)
    args = parser().parse_args(
        [
            "--download-only",
            str(links),
            "--staging-dir",
            str(tmp_path / "staging"),
            "--state",
            str(state),
            "--no-progress",
        ]
    )

    assert await cli.run(args) == 1
    assert not (tmp_path / "staging").exists()


async def _ready(value):
    return value


async def test_should_not_upload_anything_on_a_dry_run(monkeypatch, tmp_path) -> None:
    from alexandria_telegram_importer import cli

    uploaded: list[str] = []

    class FakeUploader:
        def __init__(self, **kwargs) -> None:
            pass

        async def run(self, root):
            uploaded.append("ran")
            return {"completed": 1}

    (tmp_path / "002501-dragon" / "models").mkdir(parents=True)
    (tmp_path / "002501-dragon" / "models" / "a.7z").write_bytes(b"a")

    monkeypatch.setattr(cli, "FolderUploader", FakeUploader)
    monkeypatch.setattr(
        cli, "_login", lambda args: _fail("must not log in during a dry run")
    )

    args = parser().parse_args(
        ["--upload-only", "--dry-run", "--staging-dir", str(tmp_path)],
    )

    assert await cli.run(args) == 0
    assert uploaded == []
    assert (tmp_path / "002501-dragon").is_dir()


async def test_should_not_require_telegram_credentials_for_upload_only(
    monkeypatch, tmp_path
) -> None:
    from alexandria_telegram_importer import cli

    class FakeUploader:
        def __init__(self, **kwargs) -> None:
            pass

        async def run(self, root):
            return {"completed": 1}

    class FakeClient:
        async def close(self) -> None:
            return None

    monkeypatch.delenv("TELEGRAM_API_ID", raising=False)
    monkeypatch.delenv("TELEGRAM_API_HASH", raising=False)
    monkeypatch.delenv("API_ID", raising=False)
    monkeypatch.delenv("API_HASH", raising=False)
    monkeypatch.setattr(cli, "TelegramSource", _forbidden_telegram)
    monkeypatch.setattr(cli, "FolderUploader", FakeUploader)
    monkeypatch.setattr(cli, "_login", lambda args: _ready(FakeClient()))

    args = parser().parse_args(["--upload-only", "--staging-dir", str(tmp_path)])

    assert await cli.run(args) == 0


async def test_should_report_a_staging_directory_that_does_not_exist(
    monkeypatch, tmp_path
) -> None:
    from alexandria_telegram_importer import cli

    monkeypatch.setattr(cli, "TelegramSource", _forbidden_telegram)
    args = parser().parse_args(
        ["--upload-only", "--staging-dir", str(tmp_path / "typo")],
    )

    with pytest.raises(SystemExit, match="does not exist"):
        await cli.run(args)


async def test_should_continue_with_the_next_codex_batch_after_upload(
    monkeypatch,
    tmp_path,
) -> None:
    from alexandria_telegram_importer import cli
    from alexandria_telegram_importer.tracker import StagedBundle

    staging_dir = tmp_path / "staging"
    first_path = staging_dir / "first"
    second_path = staging_dir / "second"
    first_path.mkdir(parents=True)
    second_path.mkdir()

    def item(key: str, folder_name: str) -> StagedBundle:
        return StagedBundle(
            bundle_key=key,
            source_channel_id=-100123,
            folder_name=folder_name,
            model_message_ids=(1,),
            status="downloaded",
            downloaded_at="2026-01-01T00:00:00+00:00",
        )

    stage_results = [
        cli.StagingResult((), ("bad-bundle",), 0),
        cli.StagingResult((item("first-key", "first"),), (), 10),
        cli.StagingResult((item("second-key", "second"),), (), 20),
        cli.StagingResult((), (), 0),
    ]
    stage_calls: list[set[str]] = []
    uploads: list[tuple[Path, ...]] = []
    statuses: list[tuple[str, str]] = []
    delete_modes: list[bool] = []
    logins: list[str] = []
    closes: list[str] = []

    async def fake_stage_bundles(**kwargs):
        stage_calls.append(set(kwargs["exclude_keys"]))
        return stage_results.pop(0)

    async def fake_cleanup_staged_bundles(**kwargs):
        staged = kwargs["items"][0]
        path = (staging_dir / staged.folder_name).resolve()
        return cli.CleanupBatchResult(
            (cli.ReadyBundle(staged, (path,)),),
            {"ready": 1},
        )

    class FakeRunner:
        def __init__(self, **kwargs) -> None:
            self.reference_folder = kwargs["reference_folder"]

        def preflight(self) -> None:
            return None

    class FakeUploader:
        def __init__(self, **kwargs) -> None:
            delete_modes.append(kwargs["delete_completed"])
            self.on_committed = kwargs["on_committed"]

        async def run(self, root, *, include_paths):
            uploads.append(tuple(include_paths))
            for index, path in enumerate(include_paths, start=1):
                self.on_committed(
                    path,
                    {"sessionId": f"session-{index}", "modelId": f"model-{index}"},
                )
            return {"completed": len(include_paths)}

    class FakeTracker:
        def __init__(self) -> None:
            self.records = {
                "first-key": item("first-key", "first"),
                "second-key": item("second-key", "second"),
            }

        def staged_by_status(self, channel_id, states):
            return ()

        def update_staged_status(self, bundle_key, *, status):
            statuses.append((bundle_key, status))
            self.records[bundle_key] = replace(self.records[bundle_key], status=status)
            return self.records[bundle_key]

        def record_staged_committed_output(
            self,
            bundle_key,
            *,
            output_folder,
            result,
        ):
            record = self.records[bundle_key]
            report = dict(record.cleanup_report or {})
            report["committedOutputs"] = {output_folder: result}
            self.records[bundle_key] = replace(
                record,
                status="committed_cleanup_pending",
                cleanup_report=report,
            )
            return self.records[bundle_key]

        def get_staged(self, bundle_key):
            return self.records[bundle_key]

    class FakeClient:
        async def close(self) -> None:
            closes.append("close")

    async def fake_login(args):
        logins.append("login")
        return FakeClient()

    monkeypatch.setattr(cli, "CodexCleanupRunner", FakeRunner)
    monkeypatch.setattr(cli, "stage_bundles", fake_stage_bundles)
    monkeypatch.setattr(cli, "cleanup_staged_bundles", fake_cleanup_staged_bundles)
    monkeypatch.setattr(
        cli,
        "revalidate_ready_bundle",
        lambda bundle, **kwargs: cli.ReadyRevalidation(bundle.paths, ()),
    )
    monkeypatch.setattr(cli, "FolderUploader", FakeUploader)
    monkeypatch.setattr(cli, "_login", fake_login)

    args = SimpleNamespace(
        cleanup_skill=tmp_path / "SKILL.md",
        cleanup_reference=tmp_path / "reference",
        codex_command="codex",
        codex_model=None,
        codex_reasoning_effort=None,
        cleanup_timeout=60,
        cleanup_concurrency=1,
        concurrency=1,
        stage=1,
        staging_dir=staging_dir,
    )
    telegram = SimpleNamespace(channel_id=-100123)

    exit_code = await cli.run_codex_staged_batches(
        args=args,
        telegram=telegram,
        tracker=FakeTracker(),
        refs=[],
        progress=None,
        work_root=tmp_path / "work",
    )

    assert exit_code == 1  # the failed download is reported after draining the rest
    assert len(stage_calls) == 4
    assert "bad-bundle" in stage_calls[1]
    assert uploads == [((first_path.resolve()),), ((second_path.resolve()),)]
    assert logins == ["login"]
    assert closes == ["close"]
    assert delete_modes == [True, True]
    assert statuses == [
        ("first-key", "uploading"),
        ("first-key", "uploaded"),
        ("second-key", "uploading"),
        ("second-key", "uploaded"),
    ]


async def test_should_refuse_a_mutated_ready_bundle_on_resume(
    monkeypatch,
    tmp_path,
) -> None:
    from alexandria_telegram_importer import cli
    from alexandria_telegram_importer.tracker import StagedBundle

    staging_dir = tmp_path / "staging"
    model = staging_dir / "first"
    (model / "models").mkdir(parents=True)
    (model / "images").mkdir()
    with zipfile.ZipFile(model / "models" / "Dragon.zip", "w") as archive:
        archive.writestr("dragon.stl", b"model")
    original = {
        "modelName": "Dragon",
        "metadata": {"character": "Dragon"},
        "source": {
            "channelId": -100123,
            "bundleKey": "first-key",
            "modelMessageIds": [1],
            "attachmentMessageIds": [],
        },
        "result": None,
    }
    mutated = {**original, "result": {"modelId": "tampered"}}
    (model / "metadata.json").write_text(json.dumps(mutated), encoding="utf-8")
    reference = tmp_path / "reference"
    reference.mkdir()
    (reference / "metadata.json").write_text(json.dumps(original), encoding="utf-8")
    receipt = cli.CleanupReceipt(
        status="ready",
        input_folder=model.resolve(),
        output_folders=(model.resolve(),),
        summary="ready",
        warnings=(),
        checks={
            "archivesTested": True,
            "metadataValid": True,
            "imagesFlat": True,
            "splitComplete": True,
        },
    )
    item = StagedBundle(
        bundle_key="first-key",
        source_channel_id=-100123,
        folder_name="first",
        model_message_ids=(1,),
        status="ready",
        downloaded_at="2026-01-01T00:00:00+00:00",
        output_folders=("first",),
        cleanup_report={**receipt.as_payload(), "originalMetadata": original},
    )
    transitions: list[tuple[str, str]] = []

    class FakeTracker:
        def staged_by_status(self, channel_id, statuses):
            return (item,) if statuses == ("ready",) else ()

        def update_staged_cleanup(self, bundle_key, *, status, **kwargs):
            transitions.append((bundle_key, status))
            return item

    class FakeRunner:
        def __init__(self, **kwargs) -> None:
            self.reference_folder = kwargs["reference_folder"]

        def preflight(self) -> None:
            return None

    async def no_more_bundles(**kwargs):
        return cli.StagingResult((), (), 0)

    monkeypatch.setattr(cli, "CodexCleanupRunner", FakeRunner)
    monkeypatch.setattr(cli, "stage_bundles", no_more_bundles)
    monkeypatch.setattr(cli, "_login", lambda args: _fail("must not upload"))
    args = SimpleNamespace(
        cleanup_skill=tmp_path / "SKILL.md",
        cleanup_reference=reference,
        codex_command="codex",
        codex_model=None,
        codex_reasoning_effort=None,
        cleanup_timeout=60,
        cleanup_concurrency=1,
        concurrency=1,
        stage=1,
        staging_dir=staging_dir,
    )

    exit_code = await cli.run_codex_staged_batches(
        args=args,
        telegram=SimpleNamespace(channel_id=-100123),
        tracker=FakeTracker(),
        refs=[],
        progress=None,
        work_root=tmp_path / "work",
    )

    assert exit_code == 1
    assert transitions == [("first-key", "cleanup_failed")]


async def test_should_require_review_for_an_indeterminate_upload(
    monkeypatch,
    tmp_path,
) -> None:
    from alexandria_telegram_importer import cli
    from alexandria_telegram_importer.tracker import StagedBundle

    item = StagedBundle(
        bundle_key="first-key",
        source_channel_id=-100123,
        folder_name="first",
        model_message_ids=(1,),
        status="uploading",
        downloaded_at="2026-01-01T00:00:00+00:00",
        output_folders=("first",),
        cleanup_report={"status": "ready"},
    )
    transitions: list[tuple[str, str]] = []

    class FakeTracker:
        def staged_by_status(self, channel_id, statuses):
            return (item,) if statuses == ("uploading",) else ()

        def update_staged_cleanup(self, bundle_key, *, status, **kwargs):
            transitions.append((bundle_key, status))
            return item

    class FakeRunner:
        def __init__(self, **kwargs) -> None:
            self.reference_folder = kwargs["reference_folder"]

        def preflight(self) -> None:
            return None

    async def no_more_bundles(**kwargs):
        return cli.StagingResult((), (), 0)

    monkeypatch.setattr(cli, "CodexCleanupRunner", FakeRunner)
    monkeypatch.setattr(cli, "stage_bundles", no_more_bundles)
    monkeypatch.setattr(cli, "_login", lambda args: _fail("must not upload"))
    args = SimpleNamespace(
        cleanup_skill=tmp_path / "SKILL.md",
        cleanup_reference=tmp_path / "reference",
        codex_command="codex",
        codex_model=None,
        codex_reasoning_effort=None,
        cleanup_timeout=60,
        cleanup_concurrency=1,
        concurrency=1,
        stage=1,
        staging_dir=tmp_path / "staging",
    )

    exit_code = await cli.run_codex_staged_batches(
        args=args,
        telegram=SimpleNamespace(channel_id=-100123),
        tracker=FakeTracker(),
        refs=[],
        progress=None,
        work_root=tmp_path / "work",
    )

    assert exit_code == 1
    assert transitions == [("first-key", "needs_review")]


async def test_should_record_malformed_cleanup_and_continue_with_its_sibling(
    tmp_path,
) -> None:
    from alexandria_telegram_importer import cli
    from alexandria_telegram_importer.tracker import StagedBundle

    staging_dir = tmp_path / "staging"
    reference = tmp_path / "reference"
    reference.mkdir()

    def payload(key: str, message_id: int) -> dict:
        return {
            "modelName": key,
            "metadata": {"character": key},
            "source": {
                "channelId": -100123,
                "bundleKey": key,
                "modelMessageIds": [message_id],
                "attachmentMessageIds": [],
            },
            "result": None,
        }

    originals = {"bad": payload("bad", 1), "good": payload("good", 2)}
    (reference / "metadata.json").write_text(
        json.dumps(originals["good"]),
        encoding="utf-8",
    )
    for key, original in originals.items():
        folder = staging_dir / key
        (folder / "models").mkdir(parents=True)
        (folder / "images").mkdir()
        with zipfile.ZipFile(folder / "models" / f"{key}.zip", "w") as archive:
            archive.writestr(f"{key}.stl", b"model")
        current = json.loads(json.dumps(original))
        if key == "bad":
            current["source"]["modelMessageIds"] = [{"malformed": 1}]
        (folder / "metadata.json").write_text(json.dumps(current), encoding="utf-8")

    items = tuple(
        StagedBundle(
            bundle_key=key,
            source_channel_id=-100123,
            folder_name=key,
            model_message_ids=(index,),
            status="downloaded",
            downloaded_at="2026-01-01T00:00:00+00:00",
            cleanup_report={"originalMetadata": originals[key]},
        )
        for index, key in enumerate(("bad", "good"), start=1)
    )
    by_key = {item.bundle_key: item for item in items}
    transitions: list[tuple[str, str]] = []

    class FakeTracker:
        def update_staged_cleanup(
            self,
            bundle_key,
            *,
            status,
            output_folders=(),
            report=None,
        ):
            transitions.append((bundle_key, status))
            return replace(
                by_key[bundle_key],
                status=status,
                output_folders=output_folders,
                cleanup_report=report,
            )

    class FakeRunner:
        reference_folder = reference

        async def run(self, *, bundle_key, input_folder, work_root):
            return cli.CleanupReceipt(
                status="ready",
                input_folder=input_folder,
                output_folders=(input_folder,),
                summary="prepared",
                warnings=(),
                checks={
                    "archivesTested": True,
                    "metadataValid": True,
                    "imagesFlat": True,
                    "splitComplete": True,
                },
            )

    result = await cli.cleanup_staged_bundles(
        items=items,
        staging_dir=staging_dir,
        tracker=FakeTracker(),
        runner=FakeRunner(),
        work_root=tmp_path / "work",
        concurrency=2,
    )

    assert result.outcomes == {"cleanup_failed": 1, "ready": 1}
    assert [bundle.bundle_key for bundle in result.ready_bundles] == ["good"]
    assert ("bad", "cleanup_failed") in transitions
    assert ("good", "ready") in transitions


async def test_should_finish_pending_local_deletion_after_restart(
    monkeypatch,
    tmp_path,
) -> None:
    from alexandria_telegram_importer import cli
    from alexandria_telegram_importer.tracker import ImportTracker

    staging_dir = tmp_path / "staging"
    folder = staging_dir / "first"
    folder.mkdir(parents=True)
    (folder / "archive.7z").write_bytes(b"committed")
    tracker = ImportTracker(tmp_path / "state.sqlite3")
    try:
        tracker.record_staged(
            bundle_key="first-key",
            source_channel_id=-100123,
            folder_name="first",
            model_message_ids=(1,),
        )
        tracker.update_staged_cleanup(
            "first-key",
            status="ready",
            output_folders=("first",),
            report={"status": "ready"},
        )
        tracker.update_staged_status("first-key", status="uploading")
        tracker.record_staged_committed_output(
            "first-key",
            output_folder="first",
            result={"sessionId": "session-1", "modelId": "model-1"},
        )

        class FakeRunner:
            def __init__(self, **kwargs) -> None:
                self.reference_folder = kwargs["reference_folder"]

            def preflight(self) -> None:
                return None

        async def no_more_bundles(**kwargs):
            return cli.StagingResult((), (), 0)

        monkeypatch.setattr(cli, "CodexCleanupRunner", FakeRunner)
        monkeypatch.setattr(cli, "stage_bundles", no_more_bundles)
        monkeypatch.setattr(cli, "_login", lambda args: _fail("must not upload"))
        args = SimpleNamespace(
            cleanup_skill=tmp_path / "SKILL.md",
            cleanup_reference=tmp_path / "reference",
            codex_command="codex",
            codex_model=None,
            codex_reasoning_effort=None,
            cleanup_timeout=60,
            cleanup_concurrency=1,
            concurrency=1,
            stage=1,
            staging_dir=staging_dir,
        )

        exit_code = await cli.run_codex_staged_batches(
            args=args,
            telegram=SimpleNamespace(channel_id=-100123),
            tracker=tracker,
            refs=[],
            progress=None,
            work_root=tmp_path / "work",
        )

        assert exit_code == 0
        assert not folder.exists()
        assert tracker.get_staged("first-key").status == "uploaded"
    finally:
        tracker.close()


async def test_should_retain_uncommitted_split_outputs_after_restart(
    monkeypatch,
    tmp_path,
) -> None:
    from alexandria_telegram_importer import cli
    from alexandria_telegram_importer.tracker import ImportTracker

    staging_dir = tmp_path / "staging"
    committed_folder = staging_dir / "release" / "one"
    remaining_folder = staging_dir / "release" / "two"
    committed_folder.mkdir(parents=True)
    remaining_folder.mkdir()
    (committed_folder / "archive.7z").write_bytes(b"committed")
    (remaining_folder / "archive.7z").write_bytes(b"not committed")
    tracker = ImportTracker(tmp_path / "state.sqlite3")
    try:
        tracker.record_staged(
            bundle_key="release-key",
            source_channel_id=-100123,
            folder_name="release",
            model_message_ids=(1, 2),
        )
        tracker.update_staged_cleanup(
            "release-key",
            status="ready",
            output_folders=("release/one", "release/two"),
            report={"status": "ready"},
        )
        tracker.update_staged_status("release-key", status="uploading")
        tracker.record_staged_committed_output(
            "release-key",
            output_folder="release/one",
            result={"sessionId": "session-1", "modelId": "model-1"},
        )

        class FakeRunner:
            def __init__(self, **kwargs) -> None:
                self.reference_folder = kwargs["reference_folder"]

            def preflight(self) -> None:
                return None

        async def no_more_bundles(**kwargs):
            return cli.StagingResult((), (), 0)

        monkeypatch.setattr(cli, "CodexCleanupRunner", FakeRunner)
        monkeypatch.setattr(cli, "stage_bundles", no_more_bundles)
        monkeypatch.setattr(cli, "_login", lambda args: _fail("must not upload"))
        args = SimpleNamespace(
            cleanup_skill=tmp_path / "SKILL.md",
            cleanup_reference=tmp_path / "reference",
            codex_command="codex",
            codex_model=None,
            codex_reasoning_effort=None,
            cleanup_timeout=60,
            cleanup_concurrency=1,
            concurrency=1,
            stage=2,
            staging_dir=staging_dir,
        )

        exit_code = await cli.run_codex_staged_batches(
            args=args,
            telegram=SimpleNamespace(channel_id=-100123),
            tracker=tracker,
            refs=[],
            progress=None,
            work_root=tmp_path / "work",
        )

        staged = tracker.get_staged("release-key")
        assert exit_code == 1
        assert not committed_folder.exists()
        assert remaining_folder.is_dir()
        assert staged.status == "needs_review"
        assert staged.cleanup_report["committedOutputs"]["release/one"] == {
            "sessionId": "session-1",
            "modelId": "model-1",
        }
    finally:
        tracker.close()


def _forbidden_telegram(**kwargs):
    raise AssertionError("TelegramSource must not be constructed for --upload-only")


async def _fail(message: str):
    raise AssertionError(message)
