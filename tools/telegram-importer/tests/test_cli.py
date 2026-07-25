from __future__ import annotations

import pytest

from alexandria_telegram_importer.cli import parser
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
