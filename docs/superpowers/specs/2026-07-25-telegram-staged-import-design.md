# Telegram staged import — design

Date: 2026-07-25
Components: `tools/telegram-importer`, `apps/backend`, `packages/shared`, `apps/frontend`

## Problem

The importer runs Telegram → Alexandria as one uninterruptible pipeline. Each logical
model is downloaded, uploaded, and committed with no point at which a human can look at
what was fetched. Three consequences:

1. **Multi-model releases are mis-grouped.** `build_bundles` turns a bundle of eight
   archives into eight logical models and gives the bundle's images to the *first* one
   only; the rest get a "possibly related" note and no attachments. The images usually
   belong to all eight, and which archives are variants of one model versus genuinely
   separate models is a judgment the grouping rules cannot make.
2. **No compression window.** A release of loose STLs uploads as a plain `ZIP_DEFLATED`
   archive. Getting a well-compressed `.7z` today means importing, downloading the model
   back out, compressing, and re-uploading.
3. **No naming or metadata window.** The committed name is mechanically derived from the
   filename, and the description is assembled from captions. Correcting either means
   editing the model in Alexandria afterwards.

## Goal

Split the pipeline into a **download phase** that stages Telegram bundles as folders on
disk and an **upload phase** that ingests folders into Alexandria, with an operator
intervention window between them. The two phases share no run-time state: what gets
uploaded is whatever is on disk when the upload phase runs, regardless of what was
downloaded.

## Non-goals

- Changing the existing direct-import path. `ChannelImporter` keeps its current
  behaviour, dedupe, and recovery semantics, and is not refactored.
- Deduplication in the upload phase. See "Deliberate omissions".
- Automatically splitting multi-model releases. Deciding that eight archives are eight
  models rather than one model with eight variants is the operator's job; that decision
  is the entire reason the pause exists.

---

## 1. Command surface

Three new flags on the existing `alexandria-telegram-import` command:

```bash
# Download 20 bundles and exit
alexandria-telegram-import --download-only 20 --staging-dir ./work

# Upload everything currently in ./work and exit
alexandria-telegram-import --upload-only --staging-dir ./work

# Both, with a pause between
alexandria-telegram-import --stage 20 --staging-dir ./work
```

`--staging-dir` is required by all three and rejected without one of them. `--download-only`
and `--stage` take a positive integer. The three flags are mutually exclusive. Passing none
of them keeps today's direct-import behaviour exactly.

`--stage N` runs the download phase, then prints a summary and blocks:

```
20 folders staged in ./work (14.2 GB).
Reorganize them now — split releases, compress, rename, edit metadata.json.
Press Enter to upload, or q then Enter to quit without uploading.
```

Quitting leaves the staged folders in place; a later `--upload-only` picks them up. The
pause reads from stdin and requires a newline rather than raw-mode single-key input, so a
non-interactive stdin (a pipe, `nohup`) gets EOF and is treated as quit rather than
hanging forever.

`--concurrency` and `--download-connections` apply to both phases as they do today.
`--dry-run` combined with `--download-only` or `--stage` prints the bundle plan and exits
without downloading.

---

## 2. Staged download

### Bundle selection

Bundles come from the existing `grouping.build_bundles` — no grouping changes. Each bundle
gets a **bundle key**: SHA-256 over the channel ID and every model message ID in the
bundle, sorted. This is distinct from the per-logical-model `import_key` the direct path
uses; the two key spaces never mix.

A new `staged_bundles` table in the same SQLite state file records what has been staged:

| Column | Notes |
|---|---|
| `bundle_key` | primary key |
| `source_channel_id` | |
| `folder_name` | as created, before any rename |
| `model_message_ids` | JSON array |
| `status` | `downloaded` |
| `downloaded_at` | ISO 8601 |

The existing `imports` table is untouched — its `session_id`, `model_id`, and signature
columns have no meaning for a staged bundle. Table creation follows the tracker's existing
in-place migration approach (`CREATE TABLE IF NOT EXISTS` at startup), so an existing state
file gains the table without a manual step.

`N` counts **newly staged** bundles. Any bundle whose key is already present is skipped, so
consecutive `--download-only 20` runs walk forward through the channel. Bundles are
considered in ascending message-ID order and the run stops once `N` have been staged or the
channel is exhausted.

A folder deleted by hand is not re-offered — deleting is recorded as a skip decision by the
row that remains in `staged_bundles`. Re-staging requires deleting that row.

### Folder layout

Folder name is `{first_message_id:06d}-{slug}`, where the slug comes from
`model_name_from_filename` on the bundle's first model filename, lowercased, non-alphanumerics
collapsed to hyphens, truncated to 60 characters. Zero-padding to six digits keeps a normal
channel sorting correctly in a file browser; a channel past message 999999 sorts slightly out
of order, which is cosmetic.

```
work/002501-dragon-set/
  metadata.json
  models/     every model medium in the bundle, original filenames, split parts intact
  images/     every attachment medium in the bundle
```

Filenames pass through the existing `safe_filename`. A collision within a folder gets a
`-2`, `-3` suffix before the extension. `models/` and `images/` are always created, even when
empty, so the layout is predictable.

Downloads reuse `TelegramSource.download` and the existing `ProgressReporter`; a staged
download only ever reports the `download` phase.

### Failure handling

A bundle that fails mid-download leaves no `staged_bundles` row and its partial folder is
removed, so the next run retries it. The run continues with the remaining bundles; a summary
line reports how many staged and how many failed.

---

## 3. metadata.json

Written at the root of every staged folder. The top level mirrors
`batchUploadMetadataSchema` field for field so the upload phase passes it to the commit
endpoint with no translation layer.

```json
{
  "schemaVersion": 1,

  "modelName": "Dragon Set",
  "description": "…captions, related-model note, and source line…",
  "artist": null,
  "tags": [],
  "metadata": {},
  "options": {},
  "collectionId": null,
  "newCollectionName": null,

  "source": {
    "channelId": -1001234567890,
    "channelUsername": "somechannel",
    "bundleKey": "9f2a…",
    "modelMessageIds": [2501, 2502],
    "attachmentMessageIds": [2499, 2500],
    "link": "https://t.me/somechannel/2501",
    "downloadedAt": "2026-07-25T04:12:03Z"
  },

  "result": null
}
```

`description` is exactly what `build_description` composes today — unique captions, the
possibly-related note, the channel and message IDs, and the `t.me` link — so it is edited
rather than written from scratch.

`source` is provenance. The upload phase reads none of it; it exists so a folder is
traceable to its Telegram origin after being renamed and split. `result` is filled on
disposal with `{"modelId", "sessionId", "uploadedAt"}` or `{"error", "failedAt"}`.

Unknown top-level keys are preserved on rewrite. A file that is absent is treated as "no
metadata" — the folder still uploads, named from its folder.

An **unparseable** file is not the same thing, and is handled differently by level. This file is
edited by hand, so a JSON syntax error is likely, and silently defaulting would commit a wrongly
named model while destroying the typed values:

- A **model folder** whose own `metadata.json` will not parse moves to `failed/` without
  uploading.
- A **container's** unparseable file is skipped leniently — a container commits nothing.
- In both cases the unreadable file is never rewritten. Its result goes to a sibling
  `result.json`, so hand-typed values survive.

*(Revised after review: the original spec said "unparseable → treated as no metadata" at every
level, which made a typo silently destructive.)*

---

## 4. Upload phase

### Discovery

Recursive walk from the staging root, skipping `uploaded/` and `failed/`:

- Directory contains a `models/` subdirectory → **model folder**. Upload it.
- Otherwise, directory contains subdirectories → **container**. Recurse into it.
- Directory contains `models/` **and** has a descendant model folder → **ambiguous**.
  Moved to `failed/` without uploading.

The ambiguous case is the half-finished split: archives moved into child folders but the
parent's `models/` left in place. Uploading the parent would commit two archives and
silently drop the six that were moved, so it fails loudly instead.

A staged folder therefore starts life as a model folder. Moving its archives into child
`models/` directories and removing the now-empty parent `models/` turns it into a
container. The split itself is the signal — no flag, no rename.

### Inheritance

`metadata.json` files merge from the staging root down to the model folder, at arbitrary
depth. The staging root participates as a container itself, so `<staging-dir>/metadata.json`
and `<staging-dir>/images/` supply channel-wide defaults:

- **Scalars** (`description`, `artist`, `collectionId`, `newCollectionName`) — nearest
  ancestor wins.
- **`tags`** — merged across all levels, de-duplicated, order preserved from outermost.
- **`metadata`** — merged key by key, nearest wins per key.
- **`options`** — merged key by key, nearest wins per key.
- **`modelName`** — **never inherits.** A model folder uses its own `metadata.json`
  `modelName`, or failing that its own directory name (leading `NNNNNN-` stripped, hyphens
  and underscores to spaces). Inheriting it would commit all eight models of a release as
  "Dragon Set".

This makes the release-level `metadata.json` a defaults file: set the collection, artist,
and tags once, and each child folder needs at most its own name.

### Per-folder upload

1. Resolve effective metadata by merging the inheritance chain.
2. Classify `models/`:
   - `models/` holds **exactly one entry** and it is an archive file
     (`.zip`, `.rar`, `.7z`, `.tar.gz`, `.tgz`) → upload as-is, byte for byte. No
     recompression — this is what makes a hand-made `.7z` worth creating.
   - **Every** entry is a member of one recognized split set (`.partN.rar`,
     `.zNN` + `.zip`, `.zip.NNN`) → multipart `split` upload, reusing the existing
     part-role detection in `grouping.py`. A set that is incomplete or mixes two
     different base names falls through to the zip case rather than being guessed at.
   - Anything else — several files, loose model files, subdirectories, one archive
     alongside a stray `readme.txt` → zipped with `ZIP_DEFLATED` into one archive
     preserving paths relative to `models/`.
   - Empty or missing → error, folder moves to `failed/`.
3. Upload → wait for `ready_for_review`.
4. Append every file in `images/` as attachments, plus every file in each ancestor
   container's `images/` (see below). Batched at 100 as the direct path does.
5. Commit with `batchMetadata` built from the effective metadata.
6. Wait for `committed`.

A failure at any step records the error and moves the folder to `failed/`; the run
continues with the remaining folders. `--concurrency` applies across model folders.

### Container images

Files in a container's `images/` directory are appended to **every** model folder beneath
it, in addition to that folder's own images. The case this serves: a release has ten
renders, three belong to the knight, three to the mage, and four are group shots that
belong to no single model. Distribute the six, leave the four, and every model gets the
group renders.

The cost is storage — those four images are stored once per model. The alternative,
ignoring them, silently discards images the operator deliberately left in place, which is
the worse failure. Duplicate filenames between a container's `images/` and a model's own
`images/` resolve in favour of the model's own file.

### Disposal

Per model folder, not per release — six can succeed while two fail.

- Success → moved to `uploaded/`, preserving the path relative to the staging root:
  `uploaded/002501-dragon-set/dragon-knight/`. `result` is written first.
- Failure → moved to `failed/` on the same relative path, with `result` recording the error.
- Each ancestor container's `metadata.json` is **copied** (not moved) alongside, so the
  archived copy is self-describing and later folders from the same release still see their
  defaults.
- A container is removed once it holds nothing but its own `metadata.json`. Emptiness is
  judged by what is on disk, **not** by whether discovery can still find a model folder —
  a container may hold an unsplit archive, a half-organized subfolder, or shared images, none
  of which discovery sees and all of which are the operator's work in progress.

  *(Revised after review: the original rule, "a container left with no model folders is
  removed", deleted exactly that work in progress.)*
- A move that collides with an existing path gets a `-2`, `-3` suffix rather than
  overwriting.

The staging root therefore always shows exactly what is left to do. `uploaded/` is deleted
by hand once the results have been checked.

### Deliberate omissions

The upload phase performs **no deduplication**. No Telegram media signatures, no SHA-256
content signatures, no reads or writes to the `imports` table. The folders are
hand-curated; the phase uploads what it is given.

The consequence is explicit: moving a folder back out of `uploaded/` and re-running
`--upload-only` creates a second Alexandria model. This follows directly from the phases
sharing no state, which is what allows folders to be split, merged, renamed, and
recompressed freely between them.

---

## 5. Backend metadata.json prefill

Independent of the importer and shippable as its own PR.

During import-session scanning, if the uploaded archive contains `metadata.json` at its
root, parse it and surface it on the session for the review form to prefill.

- Validated leniently against the existing `batchUploadMetadataSchema` shape, with unknown
  keys (`source`, `result`, `schemaVersion`) stripped rather than rejected.
- Invalid JSON, a non-object root, or a file over 64 KB → skipped with a debug log. Never
  fails the scan.
- Surfaced as a new optional field on the import session's `detected` payload, added to
  `packages/shared` and documented in `docs/TYPES.md` and `docs/API.md`.
- The frontend review form prefills empty fields from it and marks them as suggested.

**Prefill only — never auto-applied at commit.** The client always sends the metadata it
intends. This keeps the web UI honest (the operator sees the values before they are
applied) and guarantees the change cannot alter the outcome of any existing upload path.

The importer does not rely on this. It sends `batchMetadata` explicitly at commit, which
is what makes an upload-as-is `.7z` — whose bytes the backend cannot modify — carry its
metadata.

---

## 6. Module layout

| Module | Responsibility |
|---|---|
| `staging.py` (new) | Bundle keys, folder naming and creation, downloading a bundle into a folder, writing `metadata.json` |
| `folder_upload.py` (new) | Discovery walk, inheritance merge, `models/` classification, upload/commit, disposal |
| `folder_metadata.py` (new) | `metadata.json` read/write/merge, schema versioning |
| `tracker.py` | `staged_bundles` table and its accessors |
| `cli.py` | New flags, mutual exclusion, the pause |
| `importer.py` | Unchanged |
| `grouping.py` | `multipart_part_role` and the archive-extension constants reused by the classifier; no behaviour change |

`ChannelImporter` is deliberately not reused. The new phases reuse `TelegramSource`,
`AlexandriaClient`, `grouping`, and `progress` directly. Sharing `ChannelImporter` would
mean inheriting its dedupe, session-recovery, and signature-gate semantics, all of which
the staged flow explicitly does not want.

---

## 7. Testing

**Python — staging**
- Bundle key is stable across runs and distinct from `import_key` for the same messages.
- `--download-only N` stages exactly N new bundles and skips already-staged keys.
- Folder layout, name slugging, padding, and filename collision suffixes.
- `metadata.json` contents, including that `description` matches `build_description`.
- A failed bundle leaves no `staged_bundles` row and no partial folder.

**Python — folder upload**
- Discovery: model folder, container, nested container, ambiguous parent → `failed/`.
- Inheritance: scalar override, tag merge, per-key `metadata` merge, `modelName` not
  inheriting, missing child `metadata.json` falling back to the folder name.
- Classification: single archive uploaded as-is (byte-identical), split set detected as
  multipart, loose files zipped with relative paths preserved, empty `models/` failing.
- Container `images/` appended to every descendant; name collision favours the model's own.
- Disposal: relative path preserved, container `metadata.json` copied, emptied container
  removed, collision suffixing, `result` written in both directions.
- A folder with no `metadata.json` uploads with a folder-derived name.

**Backend**
- `metadata.json` at archive root is detected and surfaced on the session.
- Invalid JSON, non-object root, oversized file, and a nested (non-root) `metadata.json`
  are all ignored without failing the scan.
- Unknown keys are stripped; known keys survive validation.
- Commit is unaffected when the client sends no `batchMetadata` — detection never applies
  values on its own.

---

## 8. Decision log

| Decision | Rationale |
|---|---|
| One staged folder per bundle, not per logical model | The bundle is what shares images. Per-model staging re-creates the mis-grouping the feature exists to fix. |
| `models/` and `images/` subfolders | Unambiguous after hand-renaming and recompression; no extension guessing at upload time. |
| Single archive uploaded as-is | Re-wrapping a hand-made `.7z` in a zip wastes the compression work that motivated the pause. |
| Phases share no state | Folders will be split, merged, and renamed between them, so any download→upload correspondence would be wrong more often than right. |
| No dedupe on upload | Follows from the above. Hand-curated input is trusted. |
| Container metadata inherits, `modelName` does not | Set collection/artist/tags once per release; never commit eight models under one name. |
| Container `images/` inherit | Silently dropping deliberately-placed images is worse than storing them per model. |
| Ambiguous folder fails rather than uploads | A half-finished split would otherwise silently drop most of a release. |
| Pruning judges emptiness by disk contents, not by discovery | Discovery only sees model folders, so pruning on it deletes unsplit archives and shared images. |
| An unparseable model-folder `metadata.json` fails the folder | It is the one file operators edit by hand; defaulting silently commits a wrong name and destroys the typed values. |
| `--concurrency` applies to both phases | Otherwise moving from the direct path to `--download-only` is a silent throughput regression. |
| Backend prefill never auto-applies | Cannot change the outcome of any existing upload path. |
