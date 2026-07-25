"""Progress reporting for long-running Telegram imports.

The importer reports work through a `ProgressReporter`, which it receives by
constructor injection. Transport code takes a plain ``on_progress(received,
total)`` callback and never learns which reporter, if any, is listening.

Three reporters exist: `RichDashboard` draws a live terminal region,
`LogProgress` emits throttled log lines for non-terminal output, and
`NullProgress` does nothing.
"""

from __future__ import annotations

import logging
import sys
import time
from collections.abc import Callable, Iterator, Mapping
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass
from datetime import timedelta
from typing import Protocol, Self

from rich.console import Console, Group, RenderableType
from rich.live import Live
from rich.progress_bar import ProgressBar
from rich.spinner import Spinner
from rich.table import Table
from rich.text import Text

log = logging.getLogger(__name__)

LOG_INTERVAL_SECONDS = 10.0
LABEL_WIDTH = 28
BAR_WIDTH = 15
TOTAL_BAR_WIDTH = 30

#: Order in which outcome counts appear in the summary line.
OUTCOME_ORDER = ("completed", "duplicates", "skipped", "failed", "uncertain")

PHASE_DETAIL = {
    "scanning": "waiting on Alexandria",
    "committing": "committing to Alexandria",
    "hashing": "hashing for duplicate check",
    "packaging": "packaging as zip",
    "starting": "starting",
    "working": "",
}

#: Below this, a transfer rate is dominated by measurement noise, so it is
#: withheld rather than reported as an implausible number.
MIN_SPEED_SECONDS = 1.0


def format_bytes(value: float) -> str:
    amount = float(max(value, 0))
    for unit in ("B", "KB", "MB", "GB"):
        if amount < 1024 or unit == "GB":
            precision = 0 if unit in {"B", "KB"} else 1
            return f"{amount:.{precision}f} {unit}"
        amount /= 1024
    raise AssertionError("unreachable")


def format_duration(seconds: float) -> str:
    return str(timedelta(seconds=int(max(seconds, 0))))


def format_counts(counts: Mapping[str, int]) -> str:
    parts = [f"{counts[name]} {name}" for name in OUTCOME_ORDER if counts.get(name)]
    extra = sorted(set(counts) - set(OUTCOME_ORDER))
    parts.extend(f"{counts[name]} {name}" for name in extra if counts[name])
    return " · ".join(parts)


class TransferHandle(Protocol):
    def advance(self, received: int, total: int) -> None:
        """Report absolute bytes transferred so far.

        Absolute rather than incremental so that a retried transfer, which
        restarts its byte count at zero, rewinds the display instead of
        double-counting.
        """


class ModelProgress(Protocol):
    def phase(self, name: str) -> None: ...

    def transfer(self, kind: str, label: str) -> AbstractContextManager[TransferHandle]:
        """Context manager scoping one download or upload."""

    def attachments(self, done: int, total: int) -> None: ...


class ProgressReporter(Protocol):
    def __enter__(self) -> Self: ...

    def __exit__(self, *exc_info: object) -> bool: ...

    def model(self, label: str, *, parts: int) -> AbstractContextManager[ModelProgress]:
        """Context manager scoping one logical model's import."""

    def totals(self, done: int, total: int, counts: Mapping[str, int]) -> None: ...


class NullTransfer:
    def advance(self, received: int, total: int) -> None:
        pass


class NullModelProgress:
    def phase(self, name: str) -> None:
        pass

    @contextmanager
    def transfer(self, kind: str, label: str) -> Iterator[TransferHandle]:
        yield NullTransfer()

    def attachments(self, done: int, total: int) -> None:
        pass


class NullProgress:
    """Reporter that produces no output, leaving today's logging untouched."""

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc_info: object) -> bool:
        return False

    @contextmanager
    def model(self, label: str, *, parts: int) -> Iterator[ModelProgress]:
        yield NullModelProgress()

    def totals(self, done: int, total: int, counts: Mapping[str, int]) -> None:
        pass


class _LogTransfer:
    """Throttled log lines for one transfer.

    Throttling is per transfer rather than global so that concurrent imports
    each keep reporting, matching how the importer's existing log lines
    interleave.
    """

    def __init__(
        self,
        label: str,
        kind: str,
        *,
        clock: Callable[[], float],
        interval: float,
    ) -> None:
        self._label = label
        self._kind = kind
        self._clock = clock
        self._interval = interval
        self._started = clock()
        self._last_logged: float | None = None
        self._last_reported: int | None = None
        self._received = 0
        self._total = 0

    def advance(self, received: int, total: int) -> None:
        now = self._clock()
        # A retried transfer restarts its byte count at zero. Without rebasing
        # the clock, the retry's wait (a FloodWaitError sleep runs to minutes)
        # would be charged against the new attempt and halve its reported rate.
        if received < self._received:
            self._started = now
        self._received = received
        self._total = total
        if received >= total > 0:
            self._emit(now)
            return
        if self._last_logged is not None and now - self._last_logged < self._interval:
            return
        self._emit(now)

    def close(self) -> None:
        """Report where an unfinished transfer stopped, without repeating itself."""
        if self._last_reported != self._received:
            self._emit(self._clock())

    def _emit(self, now: float) -> None:
        self._last_logged = now
        self._last_reported = self._received
        elapsed = now - self._started
        speed = (
            f", {format_bytes(self._received / elapsed)}/s"
            if elapsed >= MIN_SPEED_SECONDS
            else ""
        )
        if self._total > 0:
            percent = min(int(self._received * 100 / self._total), 100)
            log.info(
                "%s %s %d%% (%s/%s%s)",
                self._label,
                self._kind,
                percent,
                format_bytes(self._received),
                format_bytes(self._total),
                speed,
            )
        else:
            log.info(
                "%s %s %s%s",
                self._label,
                self._kind,
                format_bytes(self._received),
                speed,
            )


class _LogModelProgress:
    def __init__(self, label: str, *, clock: Callable[[], float], interval: float):
        self._label = label
        self._clock = clock
        self._interval = interval

    def phase(self, name: str) -> None:
        pass

    @contextmanager
    def transfer(self, kind: str, label: str) -> Iterator[TransferHandle]:
        handle = _LogTransfer(label, kind, clock=self._clock, interval=self._interval)
        try:
            yield handle
        finally:
            handle.close()

    def attachments(self, done: int, total: int) -> None:
        pass


class LogProgress:
    """Reporter for non-terminal output: periodic log lines, no escape codes."""

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        interval: float = LOG_INTERVAL_SECONDS,
    ) -> None:
        self._clock = clock
        self._interval = interval

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc_info: object) -> bool:
        return False

    @contextmanager
    def model(self, label: str, *, parts: int) -> Iterator[ModelProgress]:
        yield _LogModelProgress(label, clock=self._clock, interval=self._interval)

    def totals(self, done: int, total: int, counts: Mapping[str, int]) -> None:
        summary = format_counts(counts)
        log.info(
            "Progress: %d/%d models%s",
            done,
            total,
            f" ({summary})" if summary else "",
        )


@dataclass
class _Row:
    slot: int
    label: str
    started: float
    phase: str = "starting"
    mode: str = "phase"
    phase_started: float = 0.0
    received: int = 0
    total: int = 0
    transfer_started: float = 0.0
    detail: str = ""


class _DashboardTransfer:
    def __init__(self, dashboard: RichDashboard, row: _Row) -> None:
        self._dashboard = dashboard
        self._row = row

    def advance(self, received: int, total: int) -> None:
        # See _LogTransfer.advance: a rewind means a retry, so the rate clock
        # restarts rather than absorbing the retry's wait.
        if received < self._row.received:
            self._row.transfer_started = self._dashboard.clock()
        self._row.received = received
        self._row.total = total


class _DashboardModelProgress:
    def __init__(self, dashboard: RichDashboard, row: _Row) -> None:
        self._dashboard = dashboard
        self._row = row

    def phase(self, name: str) -> None:
        self._row.mode = "phase"
        self._row.phase = name
        self._row.phase_started = self._dashboard.clock()
        self._row.detail = PHASE_DETAIL.get(name, name)

    @contextmanager
    def transfer(self, kind: str, label: str) -> Iterator[TransferHandle]:
        row = self._row
        row.mode = "transfer"
        row.phase = kind
        row.received = 0
        row.total = 0
        row.transfer_started = self._dashboard.clock()
        try:
            yield _DashboardTransfer(self._dashboard, row)
        finally:
            # Leaving the transfer's own label up would misreport the work that
            # follows it, so the row reverts to a neutral phase until the
            # importer names the next one.
            self.phase("working")

    def attachments(self, done: int, total: int) -> None:
        self._row.mode = "phase"
        self._row.phase = "attachments"
        self._row.detail = f"{done}/{total} files"


class RichDashboard:
    """A pinned live region: a total bar, an outcome tally, and one row per worker.

    Falls back to `LogProgress` when the terminal refuses the live region, so a
    display problem can never abort an import.
    """

    def __init__(
        self,
        *,
        console: Console | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._console = console or Console(stderr=True)
        self.clock = clock
        self._rows: dict[int, _Row] = {}
        self._done = 0
        self._total = 0
        self._counts: Mapping[str, int] = {}
        self._spinner = Spinner("dots")
        self._live: Live | None = None
        self._fallback: LogProgress | None = None
        self._log_handler: logging.Handler | None = None
        self._saved_handlers: list[logging.Handler] = []

    def __enter__(self) -> Self:
        try:
            self._live = Live(
                self,
                console=self._console,
                refresh_per_second=10,
                transient=False,
                # The console already writes to stderr; redirecting stdout too
                # would route the dry-run plan and the final summary through the
                # live region.
                redirect_stdout=False,
            )
            self._live.start()
            self._capture_logging()
        except Exception as error:  # noqa: BLE001 - display must never break imports
            log.debug("Falling back to log progress: %s", error)
            self._teardown()
            self._fallback = LogProgress()
        return self

    def __exit__(self, *exc_info: object) -> bool:
        self._teardown()
        return False

    def _teardown(self) -> None:
        """Undo everything `__enter__` installed, in reverse order.

        The live region is stopped before log handlers are restored: a restored
        handler holds the pre-redirect stream and would write straight through
        an active region.
        """
        if self._live is not None:
            try:
                self._live.stop()
            except Exception as error:  # noqa: BLE001
                log.debug("Could not stop the progress display: %s", error)
            self._live = None
        self._release_logging()

    def _capture_logging(self) -> None:
        """Route log records through the console so they scroll above the region.

        The existing formatter is reused, so log lines keep the format the
        importer already emits.
        """
        root = logging.getLogger()
        if not root.handlers:
            return
        formatter = root.handlers[0].formatter
        handler = _ConsoleLogHandler(self._console)
        handler.setFormatter(formatter)
        handler.setLevel(root.handlers[0].level)
        saved = list(root.handlers)
        # Recorded before the first removal so that an interruption part-way
        # through cannot leave the root logger with no handlers at all.
        self._saved_handlers = saved
        try:
            for existing in saved:
                root.removeHandler(existing)
            root.addHandler(handler)
            self._log_handler = handler
        except BaseException:
            self._release_logging()
            raise

    def _release_logging(self) -> None:
        if not self._saved_handlers:
            return
        root = logging.getLogger()
        self._log_handler = None
        # Restore the exact list that was captured, rather than re-adding the
        # missing ones, so handler order survives an interrupted capture.
        for existing in list(root.handlers):
            root.removeHandler(existing)
        for existing in self._saved_handlers:
            root.addHandler(existing)
        self._saved_handlers = []

    @contextmanager
    def model(self, label: str, *, parts: int) -> Iterator[ModelProgress]:
        if self._fallback is not None:
            with self._fallback.model(label, parts=parts) as delegate:
                yield delegate
            return
        slot = self._claim_slot()
        row = _Row(
            slot=slot,
            label=label,
            started=self.clock(),
            phase_started=self.clock(),
            detail=PHASE_DETAIL["starting"],
        )
        self._rows[slot] = row
        try:
            yield _DashboardModelProgress(self, row)
        finally:
            self._rows.pop(slot, None)

    def _claim_slot(self) -> int:
        slot = 1
        while slot in self._rows:
            slot += 1
        return slot

    def totals(self, done: int, total: int, counts: Mapping[str, int]) -> None:
        if self._fallback is not None:
            self._fallback.totals(done, total, counts)
            return
        self._done = done
        self._total = total
        self._counts = dict(counts)

    def __rich__(self) -> RenderableType:
        return self._render()

    def _render(self) -> RenderableType:
        now = self.clock()
        # rich refreshes on its own thread while the import mutates _rows on the
        # event loop. list() of a dict view is atomic under the GIL, so this
        # snapshot cannot see a half-removed row; iterating the live dict could
        # raise and would kill the refresh thread for the rest of the run.
        rows = sorted(self._rows.values(), key=lambda row: row.slot)
        header = Table.grid(padding=(0, 2))
        header.add_row(
            Text("  Total", style="bold"),
            ProgressBar(
                total=max(self._total, 1),
                completed=self._done,
                width=TOTAL_BAR_WIDTH,
            ),
            Text(f"{self._done}/{self._total} models"),
        )
        summary = format_counts(self._counts)
        blocks: list[RenderableType] = [header]
        if summary:
            blocks.append(Text(f"  {summary}", style="dim"))
        if rows:
            blocks.append(Text(""))
            blocks.append(self._render_rows(rows, now))
        return Group(*blocks)

    def _render_rows(self, rows: list[_Row], now: float) -> RenderableType:
        table = Table.grid(padding=(0, 2))
        for row in rows:
            slot = row.slot
            table.add_row(
                Text(f"  #{slot}", style="dim"),
                Text(_truncate(row.label, LABEL_WIDTH)),
                Text(row.phase, style="cyan"),
                self._render_indicator(row, now),
                Text(self._render_detail(row, now)),
            )
        return table

    def _render_indicator(self, row: _Row, now: float) -> RenderableType:
        if row.mode != "transfer":
            return self._spinner.render(now)
        if row.total <= 0:
            return self._spinner.render(now)
        return ProgressBar(total=row.total, completed=row.received, width=BAR_WIDTH)

    def _render_detail(self, row: _Row, now: float) -> str:
        if row.mode != "transfer":
            elapsed = format_duration(now - (row.phase_started or row.started))
            return f"{row.detail}  {elapsed}" if row.detail else elapsed
        elapsed = now - row.transfer_started
        speed = (
            f"  {format_bytes(row.received / elapsed)}/s"
            if elapsed >= MIN_SPEED_SECONDS
            else ""
        )
        if row.total > 0:
            return f"{format_bytes(row.received)}/{format_bytes(row.total)}{speed}"
        return f"{format_bytes(row.received)}{speed}"


class _ConsoleLogHandler(logging.Handler):
    def __init__(self, console: Console) -> None:
        super().__init__()
        self._console = console

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self._console.print(self.format(record), markup=False, highlight=False)
        except Exception:  # noqa: BLE001 - logging must not raise into the importer
            self.handleError(record)


def _truncate(value: str, width: int) -> str:
    return value if len(value) <= width else value[: width - 1] + "…"


@contextmanager
def guarded_reporter(reporter: ProgressReporter) -> Iterator[None]:
    """Start and stop a reporter without letting a display fault end the run.

    A reporter that fails to start is simply never started; its later calls are
    no-ops on an inactive object rather than errors.
    """
    started = False
    try:
        reporter.__enter__()
        started = True
    except Exception as error:  # noqa: BLE001
        log.debug("Progress reporter could not start: %s", error)
    try:
        yield
    finally:
        if started:
            try:
                reporter.__exit__(None, None, None)
            except Exception as error:  # noqa: BLE001
                log.debug("Progress reporter could not stop: %s", error)


@contextmanager
def guarded_model(
    reporter: ProgressReporter, label: str, *, parts: int
) -> Iterator[ModelProgress]:
    """Open a model row without letting a display fault end the run.

    The importer contains its own failures per model, so an exception escaping
    a reporter would otherwise propagate out of `asyncio.gather` and abort every
    remaining import for the sake of a progress bar.
    """
    try:
        manager = reporter.model(label, parts=parts)
        handle = manager.__enter__()
    except Exception as error:  # noqa: BLE001
        log.debug("Progress reporter could not open %s: %s", label, error)
        yield NullModelProgress()
        return
    try:
        yield handle
    finally:
        try:
            manager.__exit__(None, None, None)
        except Exception as error:  # noqa: BLE001
            log.debug("Progress reporter could not close %s: %s", label, error)


def select_reporter(
    *,
    no_progress: bool,
    dry_run: bool,
    verbose: bool,
    is_tty: bool,
    console: Console | None = None,
) -> ProgressReporter:
    """Choose a reporter. First matching condition wins."""
    if no_progress or dry_run:
        return NullProgress()
    # Debug-level output would contend with a live region for the same lines.
    if verbose:
        return LogProgress()
    if is_tty:
        return RichDashboard(console=console)
    return LogProgress()


def reporter_from_args(
    *,
    no_progress: bool,
    dry_run: bool,
    verbose: bool,
) -> ProgressReporter:
    return select_reporter(
        no_progress=no_progress,
        dry_run=dry_run,
        verbose=verbose,
        is_tty=sys.stderr.isatty(),
    )
