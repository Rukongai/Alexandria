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
  --verbose
```

`--from-message-id N` considers only Telegram messages with IDs greater than `N`. `--poll-interval` changes the default two-second Alexandria session polling interval. Run `uv run alexandria-telegram-import --help` for all options.

During a real run, the importer processes models sequentially. It downloads a model, starts an Alexandria scan, waits for `ready_for_review`, appends the assigned attachments, commits the session with a derived name and Telegram-source description, and waits for `committed` before moving to the next model. The commit sets only that name and description; the importer does not assign a collection or map Telegram content into artist, tags, or custom metadata. A failure is recorded and the run continues with later models. The command exits with status 1 when the state database contains failed imports after the run.

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

## Reruns, recovery, and limitations

The SQLite state database makes normal reruns idempotent. Each logical model has a key derived from the Telegram channel ID and its sorted model message IDs. A completed key is skipped. For an interrupted import, the importer first resumes the recorded Alexandria session; if that reference is unavailable, it searches active sessions for the deterministic upload filename before starting another upload. It can continue sessions in `scanning`, `ready_for_review`, or `committing`, and marks an already committed session complete.

This state is local coordination, not a global exactly-once guarantee:

- Deleting, replacing, or pointing `--state` at a different database can duplicate models after Alexandria no longer exposes the original import session.
- Editing a caption or adding an attachment does not change a completed model's key, so a rerun does not update that model. Changing which model-message IDs form a split set does change the key.
- The importer does not search Alexandria's finished model catalog for duplicates; recovery is based on its SQLite record and staged import sessions.
- An Alexandria error session without a model is discarded and may be retried on the next run. If the error session already has a model ID, the importer records the failure but cannot automatically roll back or recreate that model.
- The importer holds an exclusive operating-system lock for its state file. A concurrent process using the same state exits instead of racing the same Telegram models. Separate state databases use separate work roots.
- If a recorded session disappears after Alexandria returned a model ID, the importer verifies that model's status. It marks a ready model complete, but records `completion_uncertain` and refuses to upload again when it cannot prove the prior model is ready.

The state database uses SQLite WAL mode with full synchronous writes, but it cannot make the Telegram download and Alexandria HTTP operations atomic with the local state update. The deterministic upload filename and session lookup cover the normal interruption windows; they do not eliminate every duplicate possibility after state loss, session expiry, or manual server-side deletion.

## Temporary-file cleanup

Each logical model is handled in its own `TemporaryDirectory` below a state-specific `work` directory beside the SQLite state database. Split archive members are downloaded, uploaded, and deleted one at a time, so local disk usage is bounded to one model part instead of the whole set. Attachments are likewise appended and deleted one at a time. Every control path that unwinds the Python process exits the temporary context, removing remaining complete downloads, partial downloads, and generated ZIP files. The state-file process lock makes it safe for the next run to sweep stale `alexandria-tg-*` work directories left by an uncatchable termination such as `SIGKILL` or a machine power loss. The persistent Telegram session, lock file, and SQLite state database are intentionally not temporary and are not removed.

If an upload fails before Alexandria creates an import session, the importer also makes a best-effort request to delete every initialized server-side upload ID. That remote cleanup is not guaranteed when Alexandria is unreachable; backend upload/session expiry remains the fallback for server-side staging data.
