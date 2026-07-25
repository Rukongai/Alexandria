# Telegram importer progress display — design

Date: 2026-07-25
Component: `tools/telegram-importer`

## Problem

The importer reports work only through `logging` at INFO level. A single model can be
close to a gigabyte, so `Downloaded Telegram message 4821 to …` appears minutes after
`Importing dragon-bust.zip`, with nothing in between. On a channel of a hundred-plus
models the operator cannot tell throughput, remaining work, or whether a transfer has
stalled.

`--concurrency N` compounds this: up to N models are in flight, and their log lines
interleave with no indication of how many are active or what each is doing.

## Goal

A live terminal dashboard showing overall progress, a live outcome tally, and one row per
concurrent worker with its current phase and transfer rate. Degrade to periodic log lines
when stderr is not a terminal.

## Non-goals

- Byte-level progress for attachment uploads. `append_files` hands whole files to httpx;
  attachments get a file counter instead.
- Progress for Alexandria-side scanning. The importer only polls; an elapsed-time spinner
  is the honest representation.
- Changing any import, grouping, dedupe, or recovery behavior.

## Target output

```
2026-07-25 04:12:03 INFO Importing dragon-bust.zip
2026-07-25 04:12:31 INFO Imported castle-set.7z as Alexandria model 0f3a…

  Total   ━━━━━━━━━━━━━━━━━╸━━━━━━━━━━  47/143 models  0:12:31
  44 completed · 2 duplicates · 1 failed

  #1 dragon-bust.zip     upload    ━━━━━━━━━━━╸━━━  412/920 MB  8.1 MB/s
  #2 castle-set.7z.002   download  ━━━━╸━━━━━━━━━━  180/700 MB  4.4 MB/s
  #3 knight-armor.stl    scanning  ⠹  waiting on Alexandria  0:00:44
```

Log lines scroll above the live region; the block stays pinned at the bottom.

## Architecture

New module `src/alexandria_telegram_importer/progress.py`.

```python
class TransferHandle(Protocol):
    def advance(self, received: int, total: int) -> None: ...

class ModelProgress(Protocol):
    def phase(self, name: str) -> None: ...
    def transfer(self, kind: str, label: str) -> ContextManager[TransferHandle]: ...
    def attachments(self, done: int, total: int) -> None: ...

class ProgressReporter(Protocol):
    def model(self, label: str, *, parts: int) -> ContextManager[ModelProgress]: ...
    def totals(self, done: int, total: int, counts: dict[str, int]) -> None: ...
```

`kind` is `"download"` or `"upload"`. `phase` names are `"hashing"`, `"packaging"`,
`"scanning"`, `"committing"`, `"attachments"`, and the neutral `"working"`.

Three implementations:

- `NullProgress` — every method a no-op. The default, so existing callers and tests are
  unaffected.
- `LogProgress` — emits throttled `log.info` lines. No terminal control sequences.
- `RichDashboard` — the live region described above.

Rationale for explicit injection over an ambient contextvar or an event queue: the module
already wires collaborators through constructor injection (`ChannelImporter` takes
`telegram`, `alexandria`, `tracker`), and its tests substitute fakes at those seams. A
contextvar would put implicit global state in the middle of the concurrent path; an event
queue would add a second concurrency mechanism (backpressure, shutdown ordering,
drain-on-exception) for a display feature.

### Wiring

`ChannelImporter.__init__` gains `progress: ProgressReporter = NullProgress()`. The
parameter is optional and defaults to the no-op, so no existing construction site or test
changes.

- `run` computes `total_units` (already does) and calls `progress.totals` once before
  dispatch, then after each unit settles. The tally counts this run only, rather than
  reusing `tracker.counts()`, whose rows span every run against the same state file — a
  resumed import would otherwise open at 100%.
- `_process_unit` wraps its body in `with guarded_model(self.progress,
  unit.logical_filename, parts=len(unit.parts)) as handle:` and threads `handle` into
  `_resume_or_import` and `_start_session`. It settles the outcome that `_import_unit`
  returns.
- `_start_session` opens a `handle.transfer("download", part.filename)` around each
  `telegram.download`, and a `handle.transfer("upload", upload_name)` around each
  `alexandria.upload_file`. Between those it reports the `hashing` and `packaging` phases,
  which are minutes of real work on a large model and would otherwise leave the row showing
  a stale transfer label. Leaving a `transfer` context reverts the row to a neutral
  `working` phase for the same reason.
- `_resume_or_import` calls `handle.phase("scanning")` before the `ready_for_review` wait
  and `handle.phase("committing")` before the `committed` wait, and updates
  `handle.attachments(done, total)` in the attachment loop.

### Transport hooks

- `TelegramSource.download(ref, directory, *, on_progress=None)` — forwarded to Telethon's
  `progress_callback`, which is already called on the event loop. A retried download
  restarts Telethon's byte count at zero; because `advance` takes absolute bytes, the
  handles detect the rewind themselves and rebase their rate clock, so the retry's
  `FloodWaitError` sleep is not charged against its throughput. No explicit `restart()`
  call is needed on the transport side.
- `AlexandriaClient.upload_file(path, upload_name, *, multipart, on_progress=None)` —
  passed through to `_upload_part`, which calls it with cumulative bytes after each 10 MB
  chunk PUT succeeds. Chunk retries do not double-count, because the callback fires after
  the successful PUT, not per attempt.

Both parameters default to `None`, keeping the transports usable without a reporter.

## Rendering

Dependency: `rich>=13.0` added to `[project].dependencies`. Pure Python; it pulls
`markdown-it-py`, `mdurl`, and `pygments`. It is the only mainstream option that composes an overall
bar, per-worker bars, and indeterminate spinners in one live region with clean logging
interleave. `tqdm` can stack bars but offers no phase/spinner composition.

`RichDashboard` is itself the `Live` renderable: its `__rich__` builds a `Group` of

1. a `Table.grid` header — a `ProgressBar` and `47/143 models`;
2. a `Text` summary line rendered from this run's outcome tally;
3. a `Table.grid` of worker rows, each a `ProgressBar` for transfers or a `Spinner` with
   elapsed time for the waiting phases.

`rich.progress.Progress` is deliberately not used. Its task model renders one fixed column
set for every task, which cannot express rows that alternate between a byte bar and a
spinner; composing the grids directly is both shorter and exact.

All output goes to `Console(stderr=True)`. `stdout` stays clean for `describe_plan`'s
dry-run output and the final `Import state:` line, so `--dry-run > plan.txt` is unchanged.

Log interleaving uses a `logging.Handler` subclass whose `emit` calls
`console.print(self.format(record), markup=False, highlight=False)`. This preserves the
existing `%(asctime)s %(levelname)s %(message)s` format exactly — `RichHandler` is not
used, because it would reformat every log line. The handler replaces the default stream
handler for the duration of the dashboard and is removed on exit.

Worker rows are assigned the lowest free slot number when a model starts and release it
when the model settles; rows sort by slot number so a finishing `#2` does not make `#3`
jump a line mid-transfer.

Refresh is capped at 10 Hz. Telethon fires its callback far more often than that; rich's
own refresh throttling absorbs it.

`Live` refreshes from its own thread, so `__rich__` runs off the event loop while the
import is adding and removing rows. The renderer takes one `list()` snapshot of the row
values — atomic under the GIL — rather than iterating the live dict, which could raise and
kill the refresh thread for the rest of the run. `redirect_stdout=False` keeps `Live` from
routing standard output through the live region.

`__enter__` installs the live region and then the log handler; `__exit__` reverses that
order, because a restored handler holds the pre-redirect stream and would otherwise write
straight through an active region. Both the live region and the handler swap unwind
themselves if anything raises part-way, including a `KeyboardInterrupt` between removing
the old handlers and installing the new one.

## Non-TTY fallback

`LogProgress` emits at most one line per transfer per 10 seconds, plus a guaranteed final
line at completion:

```
2026-07-25 04:12:31 INFO dragon-bust.zip download 45% (412/920 MB, 8.1 MB/s)
2026-07-25 04:12:41 INFO dragon-bust.zip download 78% (718/920 MB, 8.4 MB/s)
2026-07-25 04:12:48 INFO dragon-bust.zip download 100% (920/920 MB, 8.2 MB/s)
```

Throttling is per transfer, not global, so `--concurrency 3` produces three interleaved
streams — consistent with how concurrent logs already read. The throttle clock is injected
so tests do not sleep.

`LogProgress` also logs the total line each time a model settles:
`Progress: 47/143 models (44 completed, 2 duplicates, 1 failed)`.

## Selection

New CLI flag `--no-progress`, backed by `TELEGRAM_IMPORT_NO_PROGRESS=1`.

| Condition (first match wins) | Reporter |
|---|---|
| `--no-progress` or `TELEGRAM_IMPORT_NO_PROGRESS=1` | `NullProgress` |
| `--dry-run` | `NullProgress` |
| `--verbose` | `LogProgress` |
| `sys.stderr.isatty()` | `RichDashboard` |
| otherwise | `LogProgress` |

`--verbose` selects `LogProgress` rather than the dashboard because debug-level output
would contend with the live region.

Selection lives in a pure function `select_reporter(*, no_progress, dry_run, verbose,
is_tty)` so it is testable without a terminal.

Existing `log.info("Downloaded Telegram message %d to %s")` and
`log.info("Uploading %s (%d bytes)")` are left unchanged. They are mildly redundant under
the dashboard, but leaving them makes `--no-progress` a genuine no-op with no output
regression.

## Error handling

- The dashboard must never break an import. Two helpers in `progress.py` enforce this at
  the call sites: `guarded_reporter` wraps the reporter's own start/stop, and
  `guarded_model` wraps each model row, degrading to `NullModelProgress` if the reporter
  cannot open one. `ChannelImporter._report_totals` swallows reporter faults the same way.
  `RichDashboard` additionally guards `Live.start`/`stop`, stopping a partially started
  region before falling back to `LogProgress`.
- `_settle` is called from `_process_unit`, outside `_import_unit`'s own `try`/`except`.
  `_import_unit` returns the outcome it settled on rather than settling itself. Otherwise a
  reporter fault raised while recording a completed model would be caught by that same
  `except Exception`, overwriting a completed row in the state file with `failed` and
  counting the model twice.
- A transfer that raises mid-flight leaves its `transfer` context via `finally`, removing
  the row. The failure is reported by the existing `except Exception` handler in
  `_process_unit`.
- `on_progress` callbacks are called synchronously on the event loop and must not block.
  They only mutate counters and rich task state.
- Telethon may report `total=0` for some media. Transfers with an unknown total render as
  indeterminate (spinner plus bytes transferred), not as a divide-by-zero.

## Testing

New `tests/test_progress.py`:

- `LogProgress` throttling: with an injected clock, N rapid `advance` calls produce one
  line; crossing the interval produces a second; completion always produces a final line.
- Slot allocation: slots are reused lowest-first after release; concurrent models get
  distinct slots.
- `select_reporter` returns the right class for each row of the table above.
- Unknown-total transfers do not raise.

Extensions to existing tests:

- `test_telegram_source.py` — `download` forwards `on_progress` to Telethon's
  `progress_callback`.
- `test_alexandria.py` — `upload_file` invokes `on_progress` once per chunk with
  cumulative byte counts, and does not double-count across a chunk retry.
- `test_importer.py` — a recording fake reporter asserts the phase sequence for one model
  (`download` → `hashing` → `upload` → `scanning` → `committing`, with `packaging` added for
  a bare model file) and that `totals` is called after each unit settles. Further cases
  drive a reporter that raises from `totals`, from `model`, and from `__enter__`, and assert
  the import still completes and settles once.

`RichDashboard` is a thin adapter over rich; it gets a smoke test that constructs it with
`Console(file=StringIO(), force_terminal=True)`, drives one model through every phase, and
asserts no exception. No assertions on rendered output.

## Documentation

`tools/telegram-importer/README.md` gains a "Progress output" section covering the
dashboard, the non-TTY fallback, and `--no-progress`, and the `--concurrency` section gains
a pointer to the worker rows. The existing note that "interleaved concurrent runs make log
output non-sequential" is amended to mention the dashboard.
