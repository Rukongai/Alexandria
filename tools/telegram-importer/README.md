# Telegram channel importer

The Telegram channel importer is a standalone Python companion to Alexandria. It reads media from a channel through a Telegram user account, groups recognized model files, downloads them to a temporary working directory, and sends them through Alexandria's staged upload and commit API. It does not run inside the Alexandria backend or frontend.

The importer automatically commits every successfully scanned session. Use a dry run first to verify how the channel will be grouped.

## Requirements

- Python 3.12 or later
- [`uv`](https://docs.astral.sh/uv/)
- A running Alexandria instance reachable from the machine running the importer
- A Telegram account that can read the source channel
- A Telegram API ID and API hash for that account's application
- For automated cleanup: a logged-in Codex CLI, `7z`, and extractors for the
  source archive formats (for example `unar` for RAR)

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

Set `TELEGRAM_DOWNLOAD_CONNECTIONS` to change how many connections fetch one file at once; it defaults to `8` and `--download-connections` overrides it. See [Download speed](#download-speed).

Set `TELEGRAM_STAGING_DIR` to a default directory for staged model folders; `--staging-dir` overrides it. See [Staged import](#staged-import).

For automated staged cleanup, `TELEGRAM_STAGE_CLEANUP=codex` selects Codex,
`TELEGRAM_CODEX_CLEANUP_REFERENCE` supplies the completed reference model,
`TELEGRAM_CODEX_CLEANUP_CONCURRENCY` controls simultaneous Codex processes,
and `TELEGRAM_CODEX_CLEANUP_TIMEOUT` limits each folder cleanup in seconds.
`TELEGRAM_CODEX_CLEANUP_SKILL` overrides the repository-owned cleanup skill,
`TELEGRAM_CODEX_COMMAND` selects the executable, and `TELEGRAM_CODEX_MODEL`
selects the cleanup model. `TELEGRAM_CODEX_REASONING_EFFORT` selects its
reasoning effort, such as `high`. The matching command-line flags override
these values; omit either option to use the Codex CLI default.

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
  --download-connections 8 \
  --verbose
```

`--from-message-id N` considers only Telegram messages with IDs greater than `N`. `--poll-interval` changes the default two-second Alexandria session polling interval. `--concurrency N` sets how many models are imported at the same time. Run `uv run alexandria-telegram-import --help` for all options.

During a real run, each model is downloaded, scanned by Alexandria, held until `ready_for_review`, given its assigned attachments, committed with a derived name and Telegram-source description, and awaited until `committed`. The commit sets only that name and description; the importer does not assign a collection or map Telegram content into artist, tags, or custom metadata. A failure is recorded and the run continues with the remaining models. The command exits with status 1 when the state database contains failed or completion-uncertain imports after the run.

## Staged import

The default run sends every model straight to Alexandria. A staged import splits that into a download phase and an upload phase with a pause in between, so a release can be reorganized before anything is committed. It exists for three things the direct path cannot do: splitting a release that holds several distinct models, compressing archives yourself rather than downloading and re-uploading later, and correcting names and metadata before commit rather than after.

```bash
# Stage 20 bundles as folders and exit
uv run alexandria-telegram-import --download-only 20 --staging-dir ./work

# Stage every new bundle in the channel as folders and exit
uv run alexandria-telegram-import --download-only --staging-dir ./work

# Stage only the messages named in a link file and exit
uv run alexandria-telegram-import --download-only ./message-links.txt --staging-dir ./work

# Upload every model folder currently in ./work and exit
uv run alexandria-telegram-import --upload-only --staging-dir ./work

# Both, pausing between them
uv run alexandria-telegram-import --stage 20 --staging-dir ./work

# Drain the channel in batches of 20 through Codex cleanup and upload
uv run alexandria-telegram-import \
  --stage 20 \
  --cleanup codex \
  --cleanup-reference ./completed-reference-model \
  --codex-model gpt-5.4 \
  --codex-reasoning-effort high \
  --staging-dir ./work
```

All three require `--staging-dir`, and `--staging-dir` requires one of them. `TELEGRAM_STAGING_DIR` sets the default directory. `--concurrency` applies to both phases: N bundles stage at once, and N folders upload at once. `--upload-only` is entirely local — it needs no Telegram credentials and opens no Telegram session — and combining it with `--dry-run` prints what would be uploaded without contacting Alexandria. Manual cleanup remains the default: `--stage N` without `--cleanup codex` prints one staging summary and waits for Enter before uploading exactly as before. Enter `q` to leave the folders for a later `--upload-only`; a non-interactive standard input is treated as quitting rather than hanging. Automated cleanup skips this pause and drains batches continuously.

### Downloading selected message links

Pass a text file instead of a number to `--download-only` to stage an exact
selection without scanning the rest of a channel:

```text
# message-links.txt — blank lines and whole-line comments are allowed
https://t.me/public_channel/2501
https://t.me/public_channel/2502?single
https://t.me/c/2050123456/901
```

```bash
uv run alexandria-telegram-import \
  --download-only ./message-links.txt \
  --staging-dir ./work
```

Public channel links, public preview links using `/s/`, and private channel
links using `/c/` are accepted. Duplicate links are downloaded once, and one
file may select messages from several channels visible to the signed-in
Telegram account. The links select the source channels, so `--channel`,
`TELEGRAM_CHANNEL`, and `--from-message-id` do not affect this mode.

Only the linked messages are fetched. They are ordered by message ID within
each channel and passed through the normal grouping rules, then written in the
same staging-folder layout as numeric `--download-only`. A gap containing an
unlisted message starts a new grouping run, so distant selected model posts do
not get merged just because the messages between them were filtered out.
Include every model archive part and any immediately preceding attachments you
want in the staged bundle; the importer does not fetch unlisted neighboring
messages. A missing message, a text-only message, or selected attachment media
with no following selected model is reported and makes the command exit with
status 1. Use `--dry-run` with the same arguments to inspect the selected
grouping without downloading.

Staged state records the attachment message IDs assigned to each model bundle,
so rerunning the same selection safely skips bundles already staged. If a rerun
assigns different attachments to the same bundle, or an older state row has an
unknown attachment selection, the command exits with status 1. Reconcile or
remove the existing staged folder and matching state before retrying; the
importer will not silently replace it.

### Automated Codex cleanup

`--stage N --cleanup codex` turns the one-shot staged import into a channel-drain
loop. The importer downloads at most N new bundles, gives each folder to Codex,
validates Codex's structured receipt and files, uploads only the validated
outputs, deletes each local output folder after Alexandria confirms it is
committed, and then downloads the next batch. It stops when no unstaged bundle
remains. Failed, review-required, and indeterminate folders are retained. The
batch size bounds staging disk growth; `--cleanup-concurrency` independently
controls how many Codex cleanup processes run at once.

`--cleanup codex` requires `--stage` and a reference folder containing
`metadata.json`. Use a completed model folder from this staged workflow. Codex
treats its metadata keys, key order, folder casing, and tag vocabulary as the
target shape. The importer independently enforces the reference's exact
top-level key set and rejects nested `metadata` keys that are absent from the
reference; nested reference fields may be omitted when they do not apply. The
repository-owned
`$prepare-telegram-staging` skill performs the variable work: recursive archive
inspection, character splitting, image classification, metadata research, LZMA2
repacking, and archive verification. Override its path with `--cleanup-skill`
only when developing a replacement workflow.

Codex returns one of three states per input bundle:

| State | Importer action |
|---|---|
| `ready` | Independently validate and upload only the reported model folders |
| `needs_review` | Leave the folder in place and continue with the next bundle |
| `failed` | Record `cleanup_failed`, leave the folder in place, and continue |

Before upload, the importer verifies that reported paths stay inside the assigned
bundle, every actual model folder was reported, the folder contains no symlinks,
and metadata has the reference's top-level keys and no unknown nested fields,
a non-empty model name, and a null
result. It also requires the original Telegram channel and bundle IDs, permits
only original message IDs, and checks that the outputs collectively cover every
original model message. Finally, `images/` must be flat and `models/` must contain
exactly one supported archive that passes an independent integrity test. A
`ready` receipt alone never grants upload authority.

Codex must already have a saved CLI login. The importer builds the child
environment from a small allowlist of shell, locale, proxy, certificate, and
Codex configuration variables. It intentionally excludes `CODEX_API_KEY`,
`CODEX_ACCESS_TOKEN`, Telegram credentials, Alexandria credentials, and every
other variable. Normal saved Codex authentication is reused instead. Codex runs
ephemerally in a `workspace-write` sandbox rooted at one staged bundle and
cannot perform the upload itself.

Interrupted `downloaded`, `cleaning`, and `cleanup_failed` records resume cleanup
before new downloads on the next automated run. A `ready` record resumes only
after its persisted receipt and current files pass the complete validation again.
`committed_cleanup_pending` records finish deleting only outputs whose Alexandria
session and model IDs were already persisted, without replaying their uploads.
An `uploading` record is indeterminate: Alexandria may already have committed the
model, so the importer changes it to `needs_review` instead of risking a duplicate
upload. Bundles already in `needs_review` or `upload_failed` are not retried by the
automated loop. Download failures are skipped for the rest of the current drain so
one unreachable Telegram post cannot trap the loop; they are eligible again on a
later command. The importer completes all possible batches but exits with status 1
if any download, cleanup, review, or upload issue occurred during that invocation.

### Folder layout

One folder per *bundle* — the attachments and the consecutive run of model media that grouping assigns to each other — rather than one per logical model, because the images belong to the whole bundle:

```
work/002501-dragon-set/
  metadata.json
  models/    every model medium, original filenames, split parts intact
  images/    every attachment medium
```

The name is the first model message ID zero-padded to six digits, plus a slug of the first model's filename. Both subfolders are always created, even when empty.

### Reorganizing

A folder holding `models/` is a **model folder** and becomes one Alexandria model. A folder holding only subfolders is a **container** and is recursed into. So splitting a release means moving its archives into per-model child folders and removing the now-empty parent `models/` — the split itself is the signal, with no flag to set:

```
work/002501-dragon-set/
  metadata.json          <- release defaults
  images/                <- group renders, inherited by every model below
  dragon-knight/
    metadata.json        <- modelName only; everything else inherited
    models/  images/
  dragon-mage/
    models/  images/     <- no metadata.json: name comes from the folder
```

A folder holding **both** its own `models/` and a descendant model folder is a half-finished split. It is moved to `failed/` without uploading, because committing the leftovers would silently drop everything already moved into the children.

### How a staged folder is uploaded

Each model folder is compressed into one ZIP before upload. The ZIP preserves its
`models/`, `images/`, and `metadata.json` contents at the archive root, rather than
uploading only the model archive and appending images afterward. This lets Alexandria read
`metadata.json` during scanning and prefill the pending review session. Container images
inherited by a child model are included under that child's `images/` directory. Empty or
missing `models/` directories move the folder to `failed/`.

### metadata.json

Its top level mirrors Alexandria's commit `batchMetadata` field for field:

```json
{
  "schemaVersion": 1,
  "modelName": "Dragon Knight",
  "description": "…captions, related models, and the t.me source link…",
  "artist": null, "tags": [], "metadata": {}, "options": {},
  "collectionId": null, "newCollectionName": null,
  "source": { "channelId": -100…, "modelMessageIds": [2501], "link": "https://t.me/…" },
  "result": null
}
```

`source` records where the bundle came from; the upload phase ignores it, and it survives renaming and splitting. `result` is filled on disposal. `description` is composed from the bundle's captions and source link, so it is edited rather than written from scratch. A folder with no `metadata.json` still uploads, taking its name from its folder name.

Before creating an upload session, the importer fetches Alexandria's globally
configured metadata field definitions. Concurrent folders share one in-flight
fetch, and the Alexandria client caches the successful response for later
folders handled by that client. The importer then normalizes values in the
nested `metadata` object without rewriting `metadata.json`:

| Configured type | Accepted local normalization |
|---|---|
| `text` | Keep a string; stringify a finite number or boolean; reject arrays |
| `number` | Keep a finite number or parse a numeric string |
| `boolean` | Keep a boolean or parse a case-insensitive `"true"` or `"false"` string |
| `enum` | Convert a scalar as text, reject arrays, then require a configured option when the field defines options |
| `multi_enum` | Wrap a scalar in a list or keep a list, convert each value as text, enforce the 100-value limit, then validate configured options |
| `date` | Convert a scalar as text, reject arrays, then require an ISO date or datetime, `YYYY`, or `YYYY-MM` |
| `url` | Convert a scalar as text, reject arrays, then require an HTTP or HTTPS URL with a host |

Null remains null for a configured field, and each resulting string is limited
to 10,000 characters. Unknown fields, unsupported field types, non-finite
numbers, invalid URLs or dates, disallowed enum values, and values without one
of the conversions above fail locally before any model bytes are uploaded. A
non-empty normalized map is then sent to the authoritative, non-mutating
`POST /metadata/fields/validate` route, which applies the same Tags, URL, date,
enum, and configured RE2 text-pattern checks used by import commits. This
prevents a Codex-prepared folder from reaching commit with metadata Alexandria
will reject.

Because you edit this file by hand, a JSON syntax error is treated as an error rather than as "no metadata": a **model folder** whose own `metadata.json` will not parse moves to `failed/` without uploading, and the unreadable file is never rewritten — its result is written to a sibling `result.json` instead, so your hand-typed values survive. Fix the typo and re-run. A **container's** unparseable file is still skipped leniently, since a container commits nothing.

Values merge from the staging root downward, so `<staging-dir>/metadata.json` and `<staging-dir>/images/` supply defaults to every folder in the directory — the natural place for channel-wide artist, tags, or collection.

Values merge from the outermost container down to the model folder:

| Field | Rule |
|---|---|
| `description`, `artist`, `collectionId`, `newCollectionName` | Nearest level wins |
| `tags` | Merged across every level, de-duplicated |
| `metadata`, `options` | Merged key by key, nearest wins per key |
| `modelName` | **Never inherits** — from the folder's own file, or its folder name |

A child cannot clear an inherited value by setting it to `null`; omit the field or set a replacement.

`modelName` is excluded deliberately: inheriting it would commit all eight models of a release as "Dragon Set". Everything else inheriting means the collection, artist, and tags are set once at the release root.

Files in a container's `images/` are appended to **every** model folder beneath it, so group renders you do not want to file per-model still reach each model. They are stored once per model, and a model's own `images/` wins a filename collision.

### Disposal

Each model folder settles independently — six can succeed while two fail:

```
work/
  002503-wizard-set/       <- still pending
  uploaded/
    002501-dragon-set/
      metadata.json        <- copied from the container
      dragon-knight/       <- result.modelId written into its metadata.json
  failed/
    002502-broken/         <- result.error written into its metadata.json
```

Paths relative to the staging root are preserved, each ancestor container's `metadata.json` is copied alongside, and a container is removed once it holds nothing but its own `metadata.json`. A container still holding an unsplit archive, a half-organized subfolder, or shared images is left alone — that is work in progress, not leftovers. The staging root therefore always shows exactly what is left to do. Delete `uploaded/` once the results have been checked.

### State and duplicates

Staged bundles are recorded in a `staged_bundles` table in the same SQLite state file, so consecutive `--download-only 20` runs walk forward through the channel rather than re-staging the same bundles. Deleting a folder by hand does not re-offer that bundle — deleting is recorded as a skip decision. Re-staging it means deleting its row.

Automated cleanup also stores its lifecycle, attempt count, structured receipt,
and validated output paths in `staged_bundles`. Upload transitions through
`ready`, `uploading`, and `uploaded`. A later automated invocation revalidates
`ready` outputs before resuming them; it leaves an interrupted `uploading` record
for manual Alexandria-session reconciliation because replaying an indeterminate
remote commit could create a duplicate model. Once Alexandria reports
`committed`, automated mode first records that output's Alexandria session and
model IDs as `committed_cleanup_pending`, then removes the corresponding local
model folder instead of moving it beneath `uploaded/`, and finally records the
bundle as `uploaded`. On restart it safely finishes a pending deletion; for a
partially committed split bundle it deletes only the recorded committed outputs
and leaves the remainder in `needs_review`. These durable lifecycle rows prevent
the Telegram bundle from being staged again. Manual `--upload-only` and manual
`--stage` runs retain their completed folders beneath `uploaded/` as before.

**The upload phase performs no deduplication.** No Telegram media signatures, no content hashes, no reads or writes to the `imports` table that the direct path uses. The folders are curated and uploaded as given. Automated mode's `staged_bundles` lifecycle limits which validated folders it hands to the uploader, but it does not add content or Alexandria-model deduplication. The consequence is explicit: moving a folder back out of `uploaded/` and re-running `--upload-only` creates a second Alexandria model. Manual download and upload remain deliberately decoupled, which is what lets folders be split, merged, renamed, and recompressed freely between them.

## Concurrency

`--concurrency N`, or `TELEGRAM_IMPORT_CONCURRENCY`, sets how many logical models the importer works on at once. It defaults to `1`, which imports one model at a time in Telegram message order and matches the behavior of earlier versions. Values below 1 are rejected.

Raising it overlaps the slow parts of independent models — one model downloads while another uploads or waits on an Alexandria scan — and is the main lever for importing a large channel faster. The costs scale with `N`:

- Up to `N` models occupy the work directory at once, so peak local disk use is roughly `N` times the largest model rather than one model.
- Telegram sees up to `N` concurrent download streams, which makes `FloodWaitError` throttling more likely. The importer already backs off and retries a download up to three times, but a value far above single digits invites sustained rate limiting on a large channel.
- Alexandria receives up to `N` concurrent upload and scan workloads.

Parts of one split archive are still downloaded and uploaded one at a time, which bounds disk use per model and preserves the abort path when a set turns out to be a duplicate. Attachments for a model are likewise appended one at a time. Concurrency applies between logical models, not inside one.

Interleaved concurrent runs make log output non-sequential; every import log line names the model it refers to. The progress display gives each concurrent model its own numbered row, and the final `Import state:` summary is unaffected.

Automated cleanup has a separate concurrency limit because extraction and LZMA2
compression are disk- and CPU-intensive. `--cleanup-concurrency N`, or
`TELEGRAM_CODEX_CLEANUP_CONCURRENCY`, defaults to `1`; increase it independently
from Telegram download concurrency after measuring available disk and memory.

## Download speed

`--download-connections N`, or `TELEGRAM_DOWNLOAD_CONNECTIONS`, sets how many connections fetch one file's chunks at the same time. It defaults to `8`; `1` disables parallel downloading and `16` is the maximum.

Telegram serves file chunks one request at a time per connection, so a single-connection download cannot exceed one chunk per round trip no matter how much bandwidth is available. At the ~70 ms round trip to DC1 that ceiling is a few MB/s, and it is what limits the download rather than the network. Opening several connections and keeping a request in flight on each multiplies the ceiling by the connection count until the link itself saturates.

Measured against a 78 MB model on a 20 MB/s link:

| Connections | Throughput |
|---|---|
| 1 | 1.1 MB/s |
| 8 | 15.3 MB/s |

Past eight the gains flatten as the link saturates, which is why the maximum is 16. Chunks are written straight to their offset in the target file, so a completed download is byte-identical to a single-connection one and the size check that follows every download is unchanged.

This applies to documents larger than 512 KB, which covers model archives. Photos, smaller files, and anything Telegram answers with a CDN redirect fall back to a single-connection download; the log names the file when that happens.

The connections are opened once and reused for the whole run, and they are separate from `--concurrency`: `N` concurrent models share the same pool of download connections rather than each opening their own. Raising both multiplies Telegram's view of the account's activity, so raise `--concurrency` first and only lower `--download-connections` if flood waits appear.

If Telegram terminates the parallel pool with a transport error such as HTTP
429, the importer disables that pool for the rest of the run and retries
through Telethon's managed single-connection downloader. The remaining files
continue at reduced speed instead of inheriting disconnected pooled senders.

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

The committed model name comes from the logical filename with its recognized extension removed and underscores and hyphens changed to spaces. Its description contains unique captions from the assigned attachments and the model's own message or parts, the related-model note when applicable, the channel ID and model message IDs, and a `t.me` source link for public or private channels. Descriptions are limited to Alexandria's 2,000-character request limit.

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
