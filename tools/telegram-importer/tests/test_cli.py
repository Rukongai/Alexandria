from __future__ import annotations

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


def _forbidden_telegram(**kwargs):
    raise AssertionError("TelegramSource must not be constructed for --upload-only")


async def _fail(message: str):
    raise AssertionError(message)
