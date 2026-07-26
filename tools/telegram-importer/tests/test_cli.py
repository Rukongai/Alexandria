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
            "--staging-dir",
            str(tmp_path / "staging"),
        ],
    )

    validate_staging_args(args)
    assert args.cleanup_concurrency == 1
    assert args.cleanup_timeout == 3600


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
            pass

        async def run(self, root, *, include_paths):
            uploads.append(tuple(include_paths))
            return {"completed": len(include_paths)}

    class FakeTracker:
        def staged_by_status(self, channel_id, states):
            return ()

        def update_staged_status(self, bundle_key, *, status):
            statuses.append((bundle_key, status))

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


def _forbidden_telegram(**kwargs):
    raise AssertionError("TelegramSource must not be constructed for --upload-only")


async def _fail(message: str):
    raise AssertionError(message)
