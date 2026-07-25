from __future__ import annotations

import logging
import sys
import threading
from contextlib import contextmanager
from io import StringIO

import pytest
from rich.console import Console

from alexandria_telegram_importer.progress import (
    LogProgress,
    NullModelProgress,
    NullProgress,
    RichDashboard,
    format_bytes,
    format_counts,
    guarded_model,
    select_reporter,
)


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def transfer_lines(caplog) -> list[str]:
    return [
        record.getMessage()
        for record in caplog.records
        if "download" in record.getMessage() or "upload" in record.getMessage()
    ]


def test_should_throttle_rapid_progress_within_one_interval(caplog) -> None:
    clock = FakeClock()
    progress = LogProgress(clock=clock, interval=10.0)

    with caplog.at_level(logging.INFO):
        with progress.model("dragon.zip", parts=1) as handle:
            with handle.transfer("download", "dragon.zip") as transfer:
                transfer.advance(10, 100)
                clock.advance(1.0)
                transfer.advance(20, 100)
                clock.advance(1.0)
                transfer.advance(30, 100)

    # The two mid-interval updates are collapsed into the closing line.
    lines = transfer_lines(caplog)
    assert len(lines) == 2
    assert "10%" in lines[0]
    assert "30%" in lines[1]


def test_should_log_again_once_the_interval_elapses(caplog) -> None:
    clock = FakeClock()
    progress = LogProgress(clock=clock, interval=10.0)

    with caplog.at_level(logging.INFO):
        with progress.model("dragon.zip", parts=1) as handle:
            with handle.transfer("download", "dragon.zip") as transfer:
                transfer.advance(10, 100)
                clock.advance(11.0)
                transfer.advance(50, 100)

    lines = transfer_lines(caplog)
    assert len(lines) == 2
    assert "50%" in lines[1]


def test_should_always_log_a_final_line_at_completion(caplog) -> None:
    clock = FakeClock()
    progress = LogProgress(clock=clock, interval=10.0)

    with caplog.at_level(logging.INFO):
        with progress.model("dragon.zip", parts=1) as handle:
            with handle.transfer("upload", "dragon.zip") as transfer:
                transfer.advance(10, 100)
                clock.advance(0.5)
                transfer.advance(100, 100)

    lines = transfer_lines(caplog)
    assert "100%" in lines[-1]


def test_should_log_a_closing_line_for_a_transfer_that_never_completed(caplog) -> None:
    clock = FakeClock()
    progress = LogProgress(clock=clock, interval=10.0)

    with caplog.at_level(logging.INFO):
        with progress.model("dragon.zip", parts=1) as handle:
            with handle.transfer("download", "dragon.zip") as transfer:
                transfer.advance(10, 100)
                clock.advance(2.0)
                transfer.advance(40, 100)

    lines = transfer_lines(caplog)
    assert len(lines) == 2
    assert "40%" in lines[-1]


def test_should_report_transfers_of_unknown_total_size_without_a_percentage(
    caplog,
) -> None:
    clock = FakeClock()
    progress = LogProgress(clock=clock, interval=10.0)

    with caplog.at_level(logging.INFO):
        with progress.model("photo.jpg", parts=1) as handle:
            with handle.transfer("download", "photo.jpg") as transfer:
                transfer.advance(2048, 0)

    line = transfer_lines(caplog)[0]
    assert "%" not in line
    assert "2 KB" in line


def test_should_throttle_concurrent_transfers_independently(caplog) -> None:
    clock = FakeClock()
    progress = LogProgress(clock=clock, interval=10.0)

    with caplog.at_level(logging.INFO):
        with progress.model("a.zip", parts=1) as first_handle:
            with progress.model("b.zip", parts=1) as second_handle:
                with first_handle.transfer("download", "a.zip") as first:
                    with second_handle.transfer("download", "b.zip") as second:
                        first.advance(10, 100)
                        second.advance(10, 100)

    lines = transfer_lines(caplog)
    assert sum("a.zip" in line for line in lines) == 1
    assert sum("b.zip" in line for line in lines) == 1


def test_should_log_run_totals_with_the_outcome_tally(caplog) -> None:
    with caplog.at_level(logging.INFO):
        LogProgress().totals(47, 143, {"completed": 44, "duplicates": 2, "failed": 1})

    assert "47/143 models (44 completed · 2 duplicates · 1 failed)" in caplog.text


def test_should_reuse_the_lowest_free_dashboard_slot() -> None:
    dashboard = RichDashboard(console=Console(file=StringIO(), force_terminal=True))

    with dashboard.model("first.zip", parts=1):
        with dashboard.model("second.zip", parts=1):
            with dashboard.model("third.zip", parts=1):
                assert sorted(dashboard._rows) == [1, 2, 3]
            assert sorted(dashboard._rows) == [1, 2]
        # The freed middle slot is taken before a new one is opened, so rows
        # keep stable positions.
        with dashboard.model("fourth.zip", parts=1):
            assert sorted(dashboard._rows) == [1, 2]
            assert dashboard._rows[2].label == "fourth.zip"
    assert dashboard._rows == {}


def test_should_release_a_dashboard_slot_when_a_model_fails() -> None:
    dashboard = RichDashboard(console=Console(file=StringIO(), force_terminal=True))

    with pytest.raises(RuntimeError), dashboard.model("doomed.zip", parts=1):
        raise RuntimeError("import blew up")

    assert dashboard._rows == {}


def test_should_render_every_phase_without_raising() -> None:
    output = StringIO()
    console = Console(file=output, force_terminal=True, width=120)
    clock = FakeClock()
    dashboard = RichDashboard(console=console, clock=clock)

    with dashboard:
        dashboard.totals(1, 3, {"completed": 1})
        with dashboard.model("dragon-bust.zip", parts=2) as handle:
            with handle.transfer("download", "dragon-bust.zip") as transfer:
                transfer.advance(412, 920)
                console.print(dashboard)
            with handle.transfer("upload", "dragon-bust.zip") as transfer:
                transfer.advance(0, 0)
                console.print(dashboard)
            handle.phase("scanning")
            clock.advance(44)
            console.print(dashboard)
            handle.attachments(2, 5)
            console.print(dashboard)
            handle.phase("committing")
            console.print(dashboard)

    rendered = output.getvalue()
    assert "dragon-bust.zip" in rendered
    assert "scanning" in rendered


def test_should_fall_back_to_log_progress_when_the_live_region_fails(
    monkeypatch, caplog
) -> None:
    def explode(*_args, **_kwargs):
        raise RuntimeError("terminal refused the live region")

    monkeypatch.setattr("alexandria_telegram_importer.progress.Live", explode)
    dashboard = RichDashboard(console=Console(file=StringIO(), force_terminal=True))

    with caplog.at_level(logging.INFO), dashboard:
        dashboard.totals(1, 2, {"completed": 1})
        with dashboard.model("dragon.zip", parts=1) as handle:
            with handle.transfer("download", "dragon.zip") as transfer:
                transfer.advance(50, 100)

    assert "1/2 models" in caplog.text
    assert any("dragon.zip download" in line for line in transfer_lines(caplog))


def test_should_restore_logging_handlers_after_the_dashboard_exits() -> None:
    root = logging.getLogger()
    before = list(root.handlers)
    dashboard = RichDashboard(console=Console(file=StringIO(), force_terminal=True))

    with dashboard:
        pass

    assert root.handlers == before


@pytest.mark.parametrize(
    ("kwargs", "expected"),
    [
        (
            {"no_progress": True, "dry_run": False, "verbose": False, "is_tty": True},
            NullProgress,
        ),
        (
            {"no_progress": False, "dry_run": True, "verbose": False, "is_tty": True},
            NullProgress,
        ),
        (
            {"no_progress": False, "dry_run": False, "verbose": True, "is_tty": True},
            LogProgress,
        ),
        (
            {"no_progress": False, "dry_run": False, "verbose": False, "is_tty": True},
            RichDashboard,
        ),
        (
            {"no_progress": False, "dry_run": False, "verbose": False, "is_tty": False},
            LogProgress,
        ),
    ],
)
def test_should_select_the_reporter_that_suits_the_output(kwargs, expected) -> None:
    assert isinstance(select_reporter(**kwargs), expected)


@pytest.mark.parametrize(
    ("value", "expected"),
    [(0, "0 B"), (512, "512 B"), (2048, "2 KB"), (5 * 1024**2, "5.0 MB")],
)
def test_should_format_byte_counts_for_humans(value: int, expected: str) -> None:
    assert format_bytes(value) == expected


def test_should_omit_zero_outcomes_from_the_tally() -> None:
    assert format_counts({"completed": 3, "failed": 0, "duplicates": 1}) == (
        "3 completed · 1 duplicates"
    )
    assert format_counts({}) == ""


def test_null_progress_should_accept_every_call() -> None:
    with NullProgress() as progress:
        progress.totals(1, 2, {"completed": 1})
        with progress.model("dragon.zip", parts=1) as handle:
            handle.phase("scanning")
            handle.attachments(1, 2)
            with handle.transfer("download", "dragon.zip") as transfer:
                transfer.advance(10, 100)


def test_should_not_leave_a_finished_transfer_labelling_the_next_phase() -> None:
    dashboard = RichDashboard(console=Console(file=StringIO(), force_terminal=True))

    with dashboard.model("dragon.zip", parts=1) as handle:
        with handle.transfer("download", "dragon.zip") as transfer:
            transfer.advance(50, 100)
            assert dashboard._rows[1].phase == "download"
        # Hashing and zipping happen here; the row must not still say "download".
        assert dashboard._rows[1].phase == "working"
        assert dashboard._rows[1].mode == "phase"


def test_should_withhold_an_unmeasurable_transfer_rate() -> None:
    clock = FakeClock()
    dashboard = RichDashboard(
        console=Console(file=StringIO(), force_terminal=True), clock=clock
    )

    with dashboard.model("dragon.zip", parts=1) as handle:
        with handle.transfer("download", "dragon.zip") as transfer:
            transfer.advance(500, 1000)
            row = dashboard._rows[1]
            assert "/s" not in dashboard._render_detail(row, clock.now)
            clock.advance(10.0)
            assert "50 B/s" in dashboard._render_detail(row, clock.now)


def test_should_render_while_rows_are_added_and_removed_concurrently() -> None:
    """rich refreshes on its own thread while the import mutates rows."""
    dashboard = RichDashboard(console=Console(file=StringIO(), force_terminal=True))
    failures: list[BaseException] = []
    stop = threading.Event()

    def render_forever() -> None:
        while not stop.is_set():
            try:
                dashboard._render()
            except BaseException as error:  # noqa: BLE001
                failures.append(error)
                return

    renderer = threading.Thread(target=render_forever)
    renderer.start()
    try:
        for _ in range(2000):
            with dashboard.model("a.zip", parts=1), dashboard.model("b.zip", parts=1):
                pass
    finally:
        stop.set()
        renderer.join(timeout=5)

    assert failures == []


def test_should_rebase_the_transfer_rate_clock_after_a_retry() -> None:
    clock = FakeClock()
    dashboard = RichDashboard(
        console=Console(file=StringIO(), force_terminal=True), clock=clock
    )

    with dashboard.model("dragon.zip", parts=1) as handle:
        with handle.transfer("download", "dragon.zip") as transfer:
            transfer.advance(400, 1000)
            # A FloodWaitError sleeps for minutes, then the retry restarts at 0.
            clock.advance(300.0)
            transfer.advance(0, 1000)
            clock.advance(10.0)
            transfer.advance(500, 1000)
            row = dashboard._rows[1]
            # 500 B over the retry's own 10s, not over the 310s since the first
            # attempt began.
            assert "50 B/s" in dashboard._render_detail(row, clock.now)


def test_should_rebase_the_logged_transfer_rate_after_a_retry(caplog) -> None:
    clock = FakeClock()
    progress = LogProgress(clock=clock, interval=10.0)

    with caplog.at_level(logging.INFO):
        with progress.model("dragon.zip", parts=1) as handle:
            with handle.transfer("download", "dragon.zip") as transfer:
                transfer.advance(400, 1000)
                clock.advance(300.0)
                transfer.advance(0, 1000)
                clock.advance(10.0)
                transfer.advance(500, 1000)

    assert "50 B/s" in transfer_lines(caplog)[-1]


def test_should_leave_stdout_alone_while_the_live_region_runs() -> None:
    dashboard = RichDashboard(console=Console(file=StringIO(), force_terminal=True))
    before = sys.stdout

    with dashboard:
        during = sys.stdout

    assert during is before
    assert sys.stdout is before


def test_should_restore_logging_handlers_when_capture_is_interrupted(
    monkeypatch,
) -> None:
    """A SIGINT can land between removing the old handlers and adding the new."""
    root = logging.getLogger()
    extra = logging.StreamHandler(StringIO())
    root.addHandler(extra)
    before = list(root.handlers)
    real_remove = logging.Logger.removeHandler
    calls = {"count": 0}

    def interrupted_remove(self, handler) -> None:
        calls["count"] += 1
        real_remove(self, handler)
        if calls["count"] == 1:
            raise KeyboardInterrupt

    dashboard = RichDashboard(console=Console(file=StringIO(), force_terminal=True))
    monkeypatch.setattr(logging.Logger, "removeHandler", interrupted_remove)
    try:
        with pytest.raises(KeyboardInterrupt):
            dashboard._capture_logging()
    finally:
        monkeypatch.undo()

    try:
        assert root.handlers == before
    finally:
        root.removeHandler(extra)


def test_should_stop_a_partially_started_live_region_before_falling_back(
    monkeypatch,
) -> None:
    stopped: list[bool] = []

    class HalfStartedLive:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        def start(self) -> None:
            raise RuntimeError("terminal refused the live region")

        def stop(self) -> None:
            stopped.append(True)

    monkeypatch.setattr("alexandria_telegram_importer.progress.Live", HalfStartedLive)
    dashboard = RichDashboard(console=Console(file=StringIO(), force_terminal=True))

    with dashboard:
        pass

    assert stopped == [True]
    assert dashboard._fallback is not None


def test_guarded_model_should_survive_a_reporter_that_cannot_open_a_row() -> None:
    class BrokenReporter:
        def model(self, label: str, *, parts: int):
            raise RuntimeError("reporter is broken")

    with guarded_model(BrokenReporter(), "dragon.zip", parts=1) as handle:
        handle.phase("scanning")
        with handle.transfer("download", "dragon.zip") as transfer:
            transfer.advance(1, 2)


def test_guarded_model_should_survive_a_reporter_that_cannot_close_a_row() -> None:
    class BrokenExit:
        @contextmanager
        def model(self, label: str, *, parts: int):
            yield NullModelProgress()
            raise RuntimeError("reporter blew up on exit")

    with guarded_model(BrokenExit(), "dragon.zip", parts=1) as handle:
        handle.phase("scanning")
