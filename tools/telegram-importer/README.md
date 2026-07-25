# Telegram channel importer

The Telegram channel importer is a standalone Python companion to Alexandria. It reads media from a channel through a Telegram user account, groups recognized model files, downloads them to a temporary working directory, and sends them through Alexandria's staged upload and commit API. It does not run inside the Alexandria backend or frontend.

The importer automatically commits every successfully scanned session. Use a dry run first to verify how the channel will be grouped.

## Requirements

- Python 3.12 or later
- [`uv`](https://docs.astral.sh/uv/)
- A running Alexandria instance reachable from the machine running the importer
- A Telegram account that can read the source channel
- A Telegram API ID and API hash for that account's application

Create an application in Telegram's API development tools and record its API ID and API hash. This tool signs in as a normal Telegram user (a Telethon "userbot" session); it does not accept a bot token. On the first run, Telegram prompts for the login code and, when enabled, the account's two-factor password. The resulting local session is reused on later runs, so protect it like an account credential.

## Setup with `uv`

From the repository root:

```bash
cd tools/telegram-importer
cp .env.example .env
uv sync
```

Edit `.env`:

```dotenv
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=replace-with-api-hash
TELEGRAM_PHONE=+15551234567
TELEGRAM_CHANNEL=@channel_username

ALEXANDRIA_URL=http://localhost:3000
ALEXANDRIA_EMAIL=admin@alexandria.local
ALEXANDRIA_PASSWORD=replace-with-password
# ALEXANDRIA_LIBRARY_ID=owned-library-uuid
```

`TELEGRAM_PHONE` is optional; the importer prompts for it when Telegram needs to sign in. `TELEGRAM_CHANNEL` may be a username or numeric channel ID. If it is omitted, the importer displays channels visible to the account and asks you to choose one.

`ALEXANDRIA_URL` must be the backend API base URL. The default, `http://localhost:3000`, matches local backend development. A Docker Compose deployment that exposes the backend as documented in the root README normally uses `http://localhost:3001`. The importer logs in through `POST /auth/login` and keeps the returned session cookie for the run. If `ALEXANDRIA_EMAIL` or `ALEXANDRIA_PASSWORD` is omitted, it prompts for the missing value.

Plaintext HTTP is accepted automatically only for loopback hosts such as `localhost` and `127.0.0.1`; remote Alexandria URLs must use HTTPS so the password and session cookie are encrypted in transit. For an explicitly trusted private network without TLS, `--allow-insecure-http` opts into the risk. Redirects are not followed, preventing credentials from being forwarded to a different origin.

Set `ALEXANDRIA_LIBRARY_ID` to import into a specific library owned by the Alexandria account. The importer sends it as `X-Library-Id` on all Alexandria requests. Omit it to use that account's default library.

Set `TELEGRAM_IMPORT_CONCURRENCY` to import several models at the same time; it defaults to `1` and `--concurrency` overrides it. See [Concurrency](#concurrency) for the trade-offs.

By default, the reusable Telegram login session and SQLite import state live under `$XDG_DATA_HOME/alexandria-telegram-importer`, or `~/.local/share/alexandria-telegram-importer` when `XDG_DATA_HOME` is unset. Override them with `TELEGRAM_SESSION_PATH` and `TELEGRAM_IMPORT_STATE_PATH`, or with the `--session` and `--state` command-line options.

## Preview and import

Preview the complete channel without downloading media or contacting Alexandria:

```bash
uv run alexandria-telegram-import --dry-run
```

The dry run still connects to Telegram and may create the reusable user session on first sign-in. It prints each bundle, the attachments assigned to it, the logical models, and any split-archive parts.

Run the import after checking that plan:

```bash
uv run alexandria-telegram-import
```

You can override common settings without editing `.env`:

```bash
uv run alexandria-telegram-import \
  --channel @channel_username \
  --alexandria-url http://localhost:3001 \
  --library-id 00000000-0000-4000-8000-000000000000 \
  --from-message-id 2500 \
  --concurrency 3 \
  --verbose
```

`--from-message-id N` considers only Telegram messages with IDs greater than `N`. `--poll-interval` changes the default two-second Alexandria session polling interval. `--concurrency N` sets how many models are imported at the same time. Run `uv run alexandria-telegram-import --help` for all options.

During a real run, each model is downloaded, scanned by Alexandria, held until `ready_for_review`, given its assigned attachments, committed with a derived name and Telegram-source description, and awaited until `committed`. The commit sets only that name and description; the importer does not assign a collection or map Telegram content into artist, tags, or custom metadata. A failure is recorded and the run continues with the remaining models. The command exits with status 1 when the state database contains failed or completion-uncertain imports after the run.

## Concurrency

`--concurrency N`, or `TELEGRAM_IMPORT_CONCURRENCY`, sets how many logical models the importer works on at once. It defaults to `1`, which imports one model at a time in Telegram message order and matches the behavior of earlier versions. Values below 1 are rejected.

Raising it overlaps the slow parts of independent models — one model downloads while another uploads or waits on an Alexandria scan — and is the main lever for importing a large channel faster. The costs scale with `N`:

- Up to `N` models occupy the work directory at once, so peak local disk use is roughly `N` times the largest model rather than one model.
- Telegram sees up to `N` concurrent download streams, which makes `FloodWaitError` throttling more likely. The importer already backs off and retries a download up to three times, but a value far above single digits invites sustained rate limiting on a large channel.
- Alexandria receives up to `N` concurrent upload and scan workloads.

Parts of one split archive are still downloaded and uploaded one at a time, which bounds disk use per model and preserves the abort path when a set turns out to be a duplicate. Attachments for a model are likewise appended one at a time. Concurrency applies between logical models, not inside one.

Interleaved concurrent runs make log output non-sequential; every import log line names the model it refers to. The progress display gives each concurrent model its own numbered row, and the final `Import state:` summary is unaffected.

## Progress output

In an interactive terminal the importer pins a live block below the scrolling log: an overall bar, a running tally of this run's outcomes, and one row per model being imported.

```
2026-07-25 04:12:03 INFO Importing dragon-bust.zip
2026-07-25 04:12:31 INFO Imported castle-set.7z as Alexandria model 0f3adc12

  Total   ━━━━━━━━━━━━━━━━━╸━━━━━━━━━━  47/143 models
  44 completed · 2 duplicates · 1 failed

  #1 dragon-bust.zip     upload    ━━━━━━━━━━━╸━━━  412.0 MB/920.0 MB  8.1 MB/s
  #2 castle-set.7z.002   download  ━━━━╸━━━━━━━━━━  180.0 MB/700.0 MB  4.4 MB/s
  #3 knight-armor.stl    scanning  ⠹  waiting on Alexandria  0:00:44
```

Row numbers are stable slots: a model that finishes frees its number for the next one, so rows do not jump around mid-transfer. Each row names the phase it is in — `download`, `hashing`, `packaging`, `upload`, `attachments`, `scanning`, or `committing`. Only downloads and uploads have byte-level progress; the rest show elapsed time, because the importer is waiting on Alexandria rather than moving bytes. Attachments show a file count rather than a bar, since they are uploaded whole rather than in chunks.

The tally counts this run only. Re-running against an existing state database opens at zero and counts already-imported models as `skipped`, rather than starting at the state file's historical totals.

Progress goes to standard error, leaving standard output free for `--dry-run` plans and the final `Import state:` line.

### Non-interactive output

When standard error is not a terminal — `docker compose logs`, CI, or a redirect to a file — the live block is replaced by periodic log lines, so captured logs stay readable and free of terminal escape codes:

```
2026-07-25 04:12:31 INFO dragon-bust.zip download 45% (412.0 MB/920.0 MB, 8.1 MB/s)
2026-07-25 04:12:41 INFO dragon-bust.zip download 78% (718.0 MB/920.0 MB, 8.4 MB/s)
2026-07-25 04:12:48 INFO dragon-bust.zip download 100% (920.0 MB/920.0 MB, 8.2 MB/s)
```

Each transfer logs at most once every ten seconds, plus a final line when it finishes or stops early. The throttle is per transfer, so a concurrent run produces one interleaved stream per active model.

`--verbose` also uses these lines rather than the live block, because debug output would contend with it for the same terminal.

### Turning it off

`--no-progress`, or `TELEGRAM_IMPORT_NO_PROGRESS=1`, disables both modes and restores the log output of earlier versions. A terminal that refuses the live region falls back to the periodic lines on its own; a display problem never interrupts an import.

## Exact grouping rules

Messages are considered in ascending Telegram message-ID order. Text-only messages are ignored and therefore do not create grouping boundaries. Media is classified only by filename:

- Archives (`.zip`, `.rar`, `.7z`, `.tar.gz`, `.tgz`) and model files (`.3mf`, `.amf`, `.blend`, `.fbx`, `.obj`, `.ply`, `.scad`, `.step`, `.stl`, `.stp`) are model media.
- Classic ZIP part names with exactly two decimal digits (`.zNN` plus the terminal `.zip`), numbered ZIP part names with exactly three digits (`.zip.NNN`), and modern RAR parts (`.partN.rar`) are also model media. Matching is case-insensitive. Alexandria subsequently rejects ranges that do not form one supported complete set.
- Every other photo or document is an attachment.

A bundle is a consecutive run of model media, bounded by attachment media. Attachments before that run are assigned to the bundle; trailing attachments with no later model are ignored. Within a bundle, each regular archive or model file is a separate Alexandria model. The first logical model receives all of the bundle's preceding attachments and a description note listing later models in the same run as "possibly related." Later models are still imported separately and do not receive those attachments.

Matching split parts within the same bundle are collapsed into one logical model by case-insensitive base name:

- `name.z01`, `name.z02`, ..., `name.zip`
- `name.zip.001`, `name.zip.002`, ...
- `name.part1.rar`, `name.part2.rar`, ...

The importer uploads these through Alexandria's multipart endpoints in `split` mode, producing one import session and one model. It does not use multipart `combine` mode for unrelated complete archives. Alexandria validates the part set, the 2–100 member limit, and the 5 GB per-member limit; an incomplete, unsupported, or oversized set fails instead of being guessed. Parts are discovered from the full model run and uploaded in message order, while Alexandria derives a stable logical archive name independent of upload-ID order.

A standalone model file such as an STL is wrapped in a temporary ZIP before upload. Existing archives are uploaded as-is. Uploads use Alexandria's 10 MB chunk protocol and retry each failed chunk up to three times.

The committed model name comes from the logical filename with its recognized extension removed and underscores and hyphens changed to spaces. Its description contains unique captions from the assigned attachments and the model's own message or parts, the related-model note when applicable, the channel ID and model message IDs, and a `t.me` source link when the channel has a public username. Descriptions are limited to Alexandria's 2,000-character request limit.

## Duplicate detection

In addition to skipping an already completed import key, the importer uses two signatures to avoid importing the same model from different Telegram messages:

1. Before downloading, it builds a Telegram-media signature from each model item's Telegram document/photo ID and reported byte size. A match against a completed record can skip a forwarded or otherwise Telegram-identical model without transferring it.
2. After downloading, it verifies the reported size and calculates SHA-256 over the downloaded bytes. A content-signature match catches byte-for-byte identical media even when Telegram assigned a different document or photo ID.

For both layers, a single-file model's signature represents that one file. A multipart model's signature binds every Telegram identity or SHA-256 hash to its canonical split role, such as RAR part 1, numbered ZIP part 2, or the terminal classic ZIP member. Deduplication is therefore independent of Telegram message order without treating swapped part contents as equivalent. It is whole-set only: one matching part does not cause the importer to skip a different set, and every part must have an identity for the pre-download check. Different part boundaries also produce a different signature even if extraction would yield the same files.

The importer checks only completed records in its local SQLite state whose stored Alexandria model ID still resolves to a `ready` model in the selected library. On a match, it does not create another Alexandria model. Instead, it marks the new local import record completed, points it to the existing model ID, and records which import key it duplicates. A dry run does not open the state database and therefore reports grouping only, not duplicate decisions.

Both layers match against *completed* records, so concurrent imports of the same media need extra coordination: without it, two models running at once would each find no completed match and each create an Alexandria model. The importer holds each signature it is working on for the duration of that import. A concurrent model with the same signature waits, and by the time it looks the first has completed, so it deduplicates against that model as it would on a later run. Twins are therefore collapsed onto one Alexandria model at any `--concurrency` value. A Telegram-identity twin waits before downloading and never transfers the media; a content-hash twin has already downloaded by the time the hashes can be compared, so it transfers the bytes and then discards them. If the model holding a signature fails, the waiting model finds nothing completed and imports normally.

Split archives are downloaded, hashed, and uploaded one part at a time. The SHA-256 decision cannot be made until the final part has been hashed, so earlier parts may already have initialized Alexandria uploads when the whole set proves to be a duplicate. In that case the importer aborts every upload ID initialized for the set and removes the local part files. Server abort is best-effort if Alexandria becomes unreachable; its normal upload expiry remains the fallback.

These signatures deliberately exclude attachments. Attachments remain scoped to the logical model selected by the grouping rules and are appended only when that model is actually imported. If a model is skipped as a duplicate, differently grouped or newly added attachments are not appended to the existing Alexandria model.

The pre-download Telegram signature is an optimization, not a cryptographic content hash: it trusts Telegram's media identity and reported size. The SHA-256 layer compares the downloaded container bytes, not extracted contents. Renaming byte-identical media still matches, but recompressing an archive, changing archive metadata, or repartitioning a split archive changes its hashes and may produce a separate Alexandria model even when the extracted files are equivalent.

## Reruns, recovery, and limitations

The SQLite state database makes normal reruns idempotent. Each logical model has a key derived from the Telegram channel ID and its sorted model message IDs. A completed key is skipped. The database also persists Telegram signatures, content signatures, and duplicate-to-original relationships, with indexes used for later channel scans. Existing state databases are migrated in place on startup by adding any missing nullable signature and relationship columns; no manual migration command is required. Older completed rows gain a Telegram signature when their original messages are encountered again. Their content signature remains null because completed rows are not downloaded again. For unfinished rows, rediscovery replaces the stored Telegram signature so an in-place Telegram media replacement cannot reuse a stale identity. Rows that already reference an Alexandria session or model are resumed and verified before duplicate matching; deduplication never replaces their recorded Alexandria progress.

For an interrupted import, the importer first resumes the recorded Alexandria session; if that reference is unavailable, it searches active sessions for the deterministic upload filename before starting another upload. It can continue sessions in `scanning`, `ready_for_review`, or `committing`, and marks an already committed session complete.

This state is local coordination, not a global exactly-once guarantee:

- Deleting, replacing, or pointing `--state` at a different database can duplicate models after Alexandria no longer exposes the original import session.
- Editing a caption or adding an attachment does not change a completed model's key, so a rerun does not update that model. Changing which model-message IDs form a split set does change the key.
- Duplicate discovery does not scan Alexandria's finished model catalog. It compares local SQLite signatures, then asks Alexandria only whether the candidate record's stored model ID is still ready.
- An Alexandria error session without a model is discarded and may be retried on the next run. If the error session already has a model ID, the importer records the failure but cannot automatically roll back or recreate that model.
- The importer holds an exclusive operating-system lock for its state file. A concurrent process using the same state exits instead of racing the same Telegram models. Separate state databases use separate work roots. Signature coordination is in-process only, so it protects models within one run; it is the state-file lock that keeps a second process out.
- If a recorded session disappears after Alexandria returned a model ID, the importer verifies that model's status. It marks a ready model complete, but records `completion_uncertain` and refuses to upload again when it cannot prove the prior model is ready.

The state database uses SQLite WAL mode with full synchronous writes, but it cannot make the Telegram download and Alexandria HTTP operations atomic with the local state update. The deterministic upload filename and session lookup cover the normal interruption windows; they do not eliminate every duplicate possibility after state loss, session expiry, or manual server-side deletion.

## Temporary-file cleanup

Each logical model is handled in its own `TemporaryDirectory` below a state-specific `work` directory beside the SQLite state database. Split archive members are downloaded, uploaded, and deleted one at a time, so local disk usage is bounded to one model part instead of the whole set. Attachments are likewise appended and deleted one at a time. Every control path that unwinds the Python process exits the temporary context, removing remaining complete downloads, partial downloads, and generated ZIP files. The state-file process lock makes it safe for the next run to sweep stale `alexandria-tg-*` work directories left by an uncatchable termination such as `SIGKILL` or a machine power loss. The persistent Telegram session, lock file, and SQLite state database are intentionally not temporary and are not removed.

If an upload fails before Alexandria creates an import session, the importer also makes a best-effort request to delete every initialized server-side upload ID. That remote cleanup is not guaranteed when Alexandria is unreachable; backend upload/session expiry remains the fallback for server-side staging data.
