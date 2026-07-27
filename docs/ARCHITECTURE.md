# Alexandria — Architecture Reference

This document is the source of truth for Alexandria's architecture. Every structural decision, service boundary, and type relationship is defined here. Implementation agents must consult this document before making any structural decisions. If something isn't covered here, that's a signal to propose an architecture update — not to improvise.

---

## System Overview

Alexandria is a self-hosted personal library for 3D printing model collections. It manages the upload, processing, organization, browsing, and search of 3D printing model files. The primary deployment target is Docker Compose.

The system follows a monorepo structure with a React frontend, a Fastify backend, and a shared types package. The backend is organized around focused services with clear ownership boundaries. Upload and import pipelines run asynchronously through job queues; explicit file-tree actions such as extracting a stored archive or compressing a folder run synchronously within their authenticated request.

### Core Principles

- **Upload-session-as-entity**: A staged upload session defines one model. A standard session contains one archive; an explicitly grouped session may combine several independent archives or all parts of one supported split archive. All extracted contents still belong to one model, and Alexandria never infers multiple models from archive contents.
- **Structure preservation**: Internal folder hierarchy within archives is first-class data. Relative paths are preserved and navigable.
- **Managed storage**: After import/upload, Alexandria owns all files in its managed storage root. External file references do not exist at runtime.
- **Metadata unification**: All model attributes (tags, artist, year, custom fields) are conceptually metadata. Some fields have optimized backing storage for query performance. The API treats them uniformly.
- **Server-side assembly**: The backend does the heavy lifting of data shaping. PresenterService assembles view-ready payloads. The frontend receives clean, ready-to-render data.

---

## Startup Sequence

When the backend process starts (`server.ts`), it runs four steps before accepting traffic:

1. **Storage validation** — local storage requires no remote check. For S3-compatible storage, `HeadBucket` verifies that the configured bucket is reachable with the resolved credentials. A failure exits the process before database migrations or HTTP traffic.
2. **Migrations** — Drizzle applies any pending SQL migrations from `apps/backend/src/db/migrations/`. If migration fails, the process exits with a non-zero code.
3. **Seed** — `runSeed()` inserts the default admin user and default metadata field definitions using `ON CONFLICT DO NOTHING`, then calls `LibraryService.resolveDefaultLibraryId` for the admin user to ensure the admin's default library exists. This is idempotent and safe to run on every startup. If the seed fails (e.g., a constraint violation on a partially seeded DB), it logs a warning and continues rather than crashing. Seed credentials are controlled by `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, and `SEED_ADMIN_DISPLAY_NAME` environment variables.
4. **Listen** — Fastify binds to the configured `HOST:PORT` and begins accepting requests.

In the default Docker Compose deployment, the `backend` service declares `depends_on` with `condition: service_healthy` for both Postgres and Redis, so both infrastructure services are ready before the backend starts. When `docker-compose.hosted-db.yml` is applied, the local Postgres service is placed behind an inactive profile and that dependency becomes optional; startup migrations then provide the database reachability and compatibility check. Redis remains a required local Compose dependency. The bundled production Nginx proxy uses 120-second upstream read and send timeouts, which sit above the AI assistant's 90-second whole-request deadline so application cancellation remains the authoritative cutoff.

The root `compose.yaml` is the canonical deployment entry point; `docker/docker-compose.yml` is a compatibility wrapper for the previous explicit-file command. Docker Compose 2.20.3 or later is required. The Compose project name deliberately remains `docker`, preserving the existing `docker_pgdata`, `docker_redisdata`, and `docker_storagedata` volumes when operators switch commands. Backend and frontend services define both a GHCR image and a local multi-stage build, so operators can either pull a published release with `docker compose pull` or build the current checkout with `docker compose up --build`. PostgreSQL, Redis append-only data, and managed local storage are persisted in separate named volumes. Host ports and the shared image tag are configurable through `.env`; the backend, PostgreSQL, and Redis host ports bind to `127.0.0.1`, while the frontend port is exposed on all host interfaces.

The Docker GitHub Actions workflow builds both images on relevant pull requests and manual runs without publishing them. Pushes to `main` and semantic `v*.*.*` tags first publish SBOM- and provenance-enabled `linux/amd64` and `linux/arm64` staging images. Only after both builds succeed does a final job promote the paired public tags in GHCR. Main publishes `latest`, `main`, and commit-SHA tags; version tags publish full-version, major/minor, and commit-SHA tags.

The `runSeed` function is also exported for use as a standalone CLI script (`npm run db:seed`). When invoked as a script, it closes the database pool on completion; when called from `server.ts`, it does not — the pool remains open for the lifetime of the server.

---

## Component Map

```
┌─────────────────────────────────────────────────────────┐
│                        Frontend                          │
│              React + Vite + TypeScript                    │
│         Tailwind + shadcn/ui                             │
│         Communicates with backend via REST API            │
│                                                          │
│   AppShell: PivotRail + <Outlet>                         │
│   PivotRail: AxisPicker + AxisFacetBody + UserMenu       │
│   PivotMain: top bar + context header + results grid     │
│                                                          │
│   ModelDetailPage: ModelBreadcrumb + ModelHero +         │
│     ModelDetailPanel (Info/Collections/Files tabs)       │
│     + ArchivePreviewModal + SplitFolderDialog            │
│   ToolsPage: library maintenance tools + duplicate scan  │
│   ModelViewer3DModal → lazy ModelViewer3DScene (three.js)│
│   lib/model-files.ts: STL path helpers (pure)           │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTP (JSON, multipart)
┌──────────────────────▼──────────────────────────────────┐
│                     Backend (Fastify)                     │
│                                                          │
│  ┌─────────┐  ┌──────────────┐  ┌───────────────────┐   │
│  │ Routes   │→│PresenterSvc  │←│ Services            │   │
│  │ (thin)   │  │(response     │  │                    │   │
│  │          │  │ assembly)    │  │ ModelService        │   │
│  │          │  │              │  │ ModelFolderArchive  │   │
│  └─────────┘  └──────────────┘  │ MetadataService     │   │
│                                  │ CollectionService   │   │
│  requireAuth ──→ requireLibrary  │ SearchService       │   │
│  (injects request.libraryId)     │ DuplicateScannerSvc │   │
│                                  │ AuthService         │   │
│                                  │ LibraryService      │   │
│  ┌──────────────┐               └───────────────────┘   │
│  │IngestionSvc  │──────────────→(services above)         │
│  │(orchestrates)│                                        │
│  └──────┬───────┘                                        │
│         │           ┌──────────────┐                     │
│         ├──────────→│FileProcessing│                     │
│         │           │Service       │                     │
│         │           └──────────────┘                     │
│         │           ┌──────────────┐                     │
│         ├──────────→│ThumbnailSvc  │                     │
│         │           └──────┬───────┘                     │
│         │                  │                             │
│         │           ┌──────▼───────┐                     │
│         └──────────→│StorageService│                     │
│                     └──────────────┘                     │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │ JobService    │  │UploadService │  │ImportSessionSvc │  │
│  │ (queue mgmt)  │  │(chunked      │  │(staged upload   │  │
│  │ import-scan / │  │ upload sess) │  │ sessions)       │  │
│  │ import-commit │  └──────────────┘  └─────────────────┘  │
│  └──────────────┘                   BullMQ + Redis          │
└──────────────────────┬──────────────────────────────────┘
                       │
          ┌────────────▼────────────┐
          │ PostgreSQL (local/hosted)│
          │         + Redis          │
          └─────────────────────────┘
```

### Database Connectivity

The backend uses one process-wide `node-postgres` pool shared by Drizzle and all services. `DATABASE_URL` may target the bundled Postgres container or any compatible hosted PostgreSQL service. `DATABASE_POOL_MAX` caps that pool at 10 connections by default; the hosted Compose override defaults it to 5 to leave capacity for provider administration, migrations, and other clients. Alexandria still assumes one backend process because upload state and some rate limits are process-local. Hosted PostgreSQL does not enable horizontal scaling; if that architecture changes later, every replica will have its own pool and the total database connection budget must account for all replicas.

TLS behavior comes from connection-string parameters. Alexandria deliberately does not supply a separate `ssl` object that could override `sslmode`, `sslrootcert`, `sslcert`, or `sslkey`. Production hosted deployments should use `sslmode=verify-full` with the provider's CA/root certificate so encryption, certificate trust, and hostname identity are all checked. `sslmode=require` requires encryption under standard PostgreSQL semantics but does not verify server identity and is not the recommended production setting.

The backend applies migrations at every startup and keeps its application pool open for the process lifetime. Hosted poolers therefore need session semantics. For Supabase, use a direct connection for a persistent container when IPv6 is available, or Supavisor session mode when the deployment network is IPv4-only. Transaction mode is intended for transient clients and is not supported as an Alexandria deployment target.

PostgreSQL stores metadata and application state, not model-file bytes. Moving only `DATABASE_URL` to a hosted service does not make local managed storage portable to another host; deployments that need host mobility also require the S3-compatible storage backend. Operational setup is documented in `docs/HOSTED_DATABASE.md`.

### Companion utilities

`tools/telegram-importer/` is an optional, separately installed Python userbot CLI. With Telethon,
it can either scan one Telegram channel's history or resolve the exact messages in a multi-channel
link file without scanning intervening history. It drives Alexandria exclusively through the
existing authenticated staged-upload API; it is not part of the backend runtime and does not write
to the database or storage adapter directly. Complete archives use the normal chunked upload path,
split ZIP/RAR sets use multipart `split` mode, and preceding Telegram media is appended to the
staged session before commit. The utility owns its SQLite restart and duplicate state and
short-lived local downloads; Alexandria continues to own all committed files through its configured
local or S3 storage backend. On an interactive terminal it renders a live progress dashboard on
stderr — the reason it carries `rich`, its only presentation dependency — and falls back to periodic
log lines when output is captured. That display is strictly observational: it is injected into the
importer and cannot alter, delay, or fail an import.

The staged path remains manual by default, including its existing operator pause, and can optionally
orchestrate Codex as a non-interactive, per-bundle cleanup worker. Automated cleanup requires a
completed reference folder containing `metadata.json` and uses the repository-owned cleanup skill
unless the operator explicitly overrides it. The importer remains the authority boundary: it builds
the child environment from a narrow runtime/configuration allowlist that excludes Telegram,
Alexandria, and direct Codex API credentials; gives Codex write access to only one staged bundle;
requires a structured receipt; and independently validates the claimed output allowlist, absence of
symlinks, exact reference metadata key sets, Telegram provenance and complete model-message
coverage, flat images, and the single supported archive's integrity. Only the validated path
allowlist reaches the uploader. Before creating an upload session, FolderUploader reads Alexandria's
globally configured metadata field definitions. Cold concurrent reads share one in-flight request,
and the successful result is cached on the Alexandria client for later folders. FolderUploader
normalizes only deterministic generic-field conversions: finite numbers and booleans to text,
numeric strings to numbers, `true`/`false` strings to booleans, and scalars to multi-enum lists;
arrays are rejected for scalar fields and null remains null for a configured field. A non-empty
normalized map is then checked through the authoritative, non-mutating
`POST /metadata/fields/validate` route, which shares the import commit's Tags, URL, date,
enum-option, RE2 pattern, value-count, and length validation. Unknown fields, unsupported types,
and ambiguous or invalid values fail without transferring model bytes. Automated mode drains the
channel in bounded batches, skips staging failures for the rest of the current invocation, and
persists cleanup attempts, receipts, output paths, and lifecycle states in the importer's SQLite
database. `ready` records are fully revalidated against their persisted receipt and current files
before upload resumes; an interrupted `uploading`
record becomes `needs_review` because replaying an indeterminate remote commit could create a
duplicate. `downloaded`, `cleaning`, and `cleanup_failed` records resume cleanup before any new
downloads. `needs_review` and `upload_failed` remain for operator intervention. Codex never receives
Alexandria upload authority. After Alexandria confirms a model is committed, automated mode deletes
that validated local output folder only after durably recording its session and model identity in a
`committed_cleanup_pending` lifecycle state, then finalizes the bundle as `uploaded`. Startup finishes
pending deletions without replaying the remote commit; a partially committed split retains its
uncommitted outputs for review. Manual staged uploads continue moving completed folders beneath
`uploaded/` for operator retention.

Duplicate detection is local to the utility's state database and has two layers. Before download, a
signature over the complete logical model's Telegram document/photo IDs and reported sizes
can match media already associated with a completed import. After download, a signature over the
SHA-256 hashes of every model file or split-archive part catches byte-identical media with a
different Telegram identity. A match is honored only when its persisted Alexandria model ID still
resolves as `ready`; the duplicate record is then completed against that existing model. Telegram
identity is not a content hash, and the SHA-256 layer compares archive bytes rather than extracted
contents, so recompressed or repartitioned archives are distinct. Attachments are excluded from both
signatures and remain scoped to the model selected by Telegram grouping. Multipart signatures bind
each identity or hash to its canonical split-archive role, preventing swapped part contents from
matching while remaining independent of Telegram message order. For multipart uploads, the
content decision occurs only after every part is hashed; if prior parts were already initialized,
the utility requests a best-effort abort for all of their upload IDs before recording the duplicate
and removes its local part files. On startup, the SQLite tracker adds missing nullable signature and
duplicate-link columns and creates lookup indexes, so existing state files migrate in place.

Logical models are imported under a configurable concurrency limit that defaults to one, preserving
the original sequential message order. Concurrency applies between models, not within one: the parts
of a split archive and a model's attachments are still transferred one at a time, which bounds local
disk use per model and preserves the abort path for a duplicate set. Because both duplicate layers
match only completed records, concurrent imports of identical media would otherwise each miss the
other and create separate models. An in-process gate holds each signature for the duration of its
import, so a concurrent twin waits and then resolves against the completed original. The gate is
acquired Telegram-signature first and content-signature second, and a holder always owns a
concurrency slot, so neither the gate nor the semaphore can deadlock the run. This coordination is
in-process only; the existing exclusive lock on the state file remains what prevents a second
importer process from racing the same channel.

---

## Data Model: Library Scope

Every model and collection belongs to a library. Libraries are the top-level organizational scope introduced in P1 as a foundation for multi-library support, surfaced to users in **P5** (All-Libraries home, `/lib/:id` routing, switcher, per-library scoping).

### Schema

The `libraries` table (`apps/backend/src/db/schema/library.ts`) has these columns: `id` (UUID PK), `name`, `slug` (globally unique), `user_id` (FK → users), `is_default` (boolean), `color` (palette-accent name; added by `0010_add_library_color`, defaulted to `amber`), `created_at`, `updated_at`.

Both `models` and `collections` carry a `library_id` column (NOT NULL FK → libraries). This was added by migration `0007_add_library_id` after `0005_add_libraries` created the table and `0006_backfill_default_libraries` ensured every existing user had exactly one default library to backfill into.

One-default-per-user is enforced at the database level with a partial unique index:

```sql
CREATE UNIQUE INDEX libraries_user_default_unique ON libraries (user_id) WHERE is_default
```

This index makes the enforcement race-safe: the database rejects a second `is_default = true` row for the same user even under concurrent writes.

### LibraryService

`LibraryService` owns library resolution **and** management CRUD (expanded in P5). Methods all take `userId` explicitly and never trust a `libraryId` without an ownership check:

- `resolveDefaultLibraryId(userId)` — finds the user's `is_default = true` library, lazily creating one (name `"Library"`) if none exists. The seed (`runSeed`) calls this for the admin on startup so a default always exists.
- `resolveLibraryId(userId, requestedId?)` — the scope resolver used by `requireLibrary`: returns `requestedId` if owned (else `NOT_FOUND`), otherwise the default.
- `requireOwnedLibrary(userId, libraryId)` — ownership guard returning `NOT_FOUND` (no enumeration), reused by the management routes.
- `listLibraries(userId)` — libraries with derived model/collection counts (two grouped queries, default-first ordering).
- `createLibrary` / `updateLibrary` / `setDefaultLibrary` / `deleteLibrary` — management CRUD. `setDefaultLibrary` clears the prior default and sets the new one in one transaction (the partial unique index never sees two defaults). `deleteLibrary` refuses (`CONFLICT`) the default, the user's last library, or a non-empty library.

### The `requireLibrary` Prehandler

`requireLibrary` (`apps/backend/src/middleware/library.ts`) is a Fastify preHandler that runs after `requireAuth` on every route that reads or writes library-scoped data. It reads an optional **`X-Library-Id`** header and calls `LibraryService.resolveLibraryId(userId, header)`, storing the result on `request.libraryId`. Absent header → the user's default library (preserving pre-P5 single-library behavior).

**Security invariant:** the active `libraryId` is never trusted from untrusted input. The header is accepted only after `resolveLibraryId` confirms the user owns that library; an unknown or un-owned id returns `NOT_FOUND` (same error either way, so ids cannot be enumerated). The model-move endpoint is the one intentional exception: it accepts a `targetLibraryId` body field and independently verifies that the destination belongs to the authenticated user. The frontend mirrors its `/lib/:id` route segment into the header; the `/libraries` management routes do **not** use `requireLibrary` (they manage the scope itself, keyed by URL `:id` + `userId`).

Routes that apply `requireLibrary` (as of P5):

- `GET /models`, `GET /models/:id`, `GET /models/:id/files`, `GET /models/:id/status`, `POST /models/:id/files/delete`, `POST /models/:id/folders/compress`
- `GET /collections`, `POST /collections`, `GET /collections/:id`, `GET /collections/:id/models`
- `GET /metadata/fields/:slug/values`
- `POST /models/upload`, `POST /models/upload/:uploadId/complete`, `POST /models/upload/multipart/complete`, `POST /models/import`
- `GET /models/import-sessions`, `POST /models/import-sessions/:id/commit`
- `GET /search`
- `GET /tools/duplicates`, `POST /tools/duplicates/mark`, `POST /tools/duplicates/file-groups/:hash/mark`, `POST /tools/duplicates/file-groups/:hash/ignore`, `POST /tools/duplicates/consolidate/preview`, `POST /tools/duplicates/consolidate`
- All `/smart-collections` routes
- All `/bulk/*` routes
- `POST /ai/chat`, `POST /ai/proposals/:id/apply`

`POST /models/:id/move` is an authenticated, cross-library mutation. It locks and ownership-checks the model, verifies the destination library belongs to the same user, moves the model atomically, removes collection memberships that point into the source library, and reconciles duplicate flags in both libraries. Metadata and tags remain attached because their definitions are global rather than library-scoped.

P5 added library-scope guards to the read/detail routes above via `ModelService.requireModelInLibrary` / `CollectionService.requireCollectionInLibrary` (the entity must belong to `request.libraryId`, else `NOT_FOUND`), so a stale deep link to another library's item 404s after switching. By-id **mutation** routes (`PATCH`/`DELETE /models/:id`, `PATCH`/`DELETE /collections/:id`) remain `userId`-owned only — they are same-user operations and were intentionally left out of the minimal P5 sweep. The cross-library model move is also user-owned, but uses an explicit destination ownership check and transaction because it changes library scope.

### P4: Smart Collections (shipped)

Smart collections were implemented in P4. Key architectural facts:

- **Entity**: The `smart_collections` table (`apps/backend/src/db/schema/smart-collection.ts`, migration `0009_add_smart_collections.sql`) stores `id`, `name`, `slug` (globally unique), `description`, `definition` (JSONB rule tree typed as `RuleNode`), `userId`, `libraryId`, and timestamps. There is no membership join table — results are derived on read, never materialized.

- **Rule engine**: `apps/backend/src/services/rule-engine.ts` compiles a nested `RuleNode` tree into a Drizzle `SQL` condition. The engine is pure (no I/O). It exports `buildLeafCondition`, which `search.service.ts` also uses for its own flat filter logic — this is the single source of truth for "what SQL a filter on dimension X looks like." Both code paths are guaranteed to produce identical results for equivalent criteria.

- **`applyDefaultStatus` seam**: `searchModels` normally applies an implicit `status = 'ready'` filter. When a smart collection's rule tree contains a `status` condition, `SmartCollectionService.resolveAndCompile` sets `applyDefaultStatus: false`, suppressing the default so it does not contradict the rule. This flag travels through `SearchModelsOptions` into `searchModels`.

- **Cross-tenant guard**: Every by-id route goes through `SmartCollectionService.requireOwnedSmartCollection`, which verifies the row exists, belongs to the requesting user, and belongs to the library. A mismatch on any check returns `NOT_FOUND` — the same error shape regardless of which check failed, so IDs cannot be enumerated across tenants.

- **`searchAll` global-search union still deferred**: `SearchService.searchAll` returns only manual collections. Unioning smart collections into global search results is a fast-follow that was explicitly deferred from this phase.

### P5: Multi-library (shipped)

P5 surfaced the library layer to users:

- **Backend**: `color` column (migration `0010`), expanded `LibraryService` CRUD, `requireLibrary` resolving the `X-Library-Id` header, a `/libraries` route module, and library-scope guards on read/detail routes (see above).
- **Frontend**: an `X-Library-Id` header seam in `api/client.ts` (module-level `activeLibraryId` set by `LibraryProvider` from the `/lib/:id` route), the All-Libraries home, `/lib/:id` routing, the rail switcher, and library-relative navigation via `useLibraryPath`. Because library-scoped React Query keys do not include the library id (scoping rides on the header), `LibraryProvider` clears non-`libraries` queries when the active library changes so the workspace never shows the previous library's cached data.

Still deferred:

- By-id **mutation** routes are not library-scoped (same-user operations; see above).
- Per-collection group counts in group view (requires server support to return paginated per-group totals).
- Multi-user / invites / roles (P6).

---

## Local MCP Server

`apps/backend/src/mcp/` is a separate stdio entry point for trusted, local Model Context Protocol
clients. It is not registered with Fastify and does not start the HTTP server, ingestion workers,
migrations, or seed logic. The process requires `ALEXANDRIA_MCP_USER_ID`, resolves either that
user's owned `ALEXANDRIA_MCP_LIBRARY_ID` or their default library, and applies both values as a
server-owned scope to every tool call. Tool input can never select a different user or library.

The MCP adapter exposes search, raw model inspection, a focused raw model-file listing, managed-file
download, model and metadata updates, tag changes, merge, and delete. Mutations delegate to
`ModelService`, `MetadataService`, `LibraryService`, and the configured `IStorageService` rather
than duplicating domain rules.

Raw inspection is the deliberate exception to presenter DTOs: a dedicated read repository returns
all columns from the model and related model-file, folder, metadata-definition/value, tag-membership,
collection-membership, and thumbnail rows so MCP clients can inspect information the UI does not
render. Ownership and library membership are checked before those related rows are queried.
The focused file-list tool applies the same ownership check, then returns the model-file rows in
relative-path order without querying the model's other relationships.

Downloads stream through `IStorageService`, so local and S3-backed libraries behave identically.
They may write only beneath a pre-created `ALEXANDRIA_MCP_DOWNLOAD_DIR`; relative-path validation, real-path and
symlink checks, process-user ownership and ancestor write-permission checks, all-file staging with
rollback, and no-overwrite-by-default behavior prevent stored path data, tool input, another local
account, or a later stream failure from creating an escaped or partial download set. Because stdout
is reserved for MCP JSON-RPC,
the MCP entry point marks the process so shared application logging is routed to stderr.

## Service Inventory

### LibraryService

**Owns:** Resolving a user's active library (default or `X-Library-Id`-requested, ownership-checked) and full library management CRUD (list-with-counts, create, rename/recolor, set-default, delete).

**Does not own:** Any data scoped *within* a library (models, collections, etc.), or multi-user sharing (P6).

**Behavior:** `resolveDefaultLibraryId(userId)` finds (or lazily creates) the user's default library; `resolveLibraryId(userId, requestedId?)` validates a requested library against ownership before use. Management methods are detailed under *Data Model: Library Scope → LibraryService*. The partial unique index on `(user_id) WHERE is_default` keeps default resolution and `setDefaultLibrary` race-safe.

### IngestionService

**Owns:** Upload and import orchestration, pipeline sequencing, Model record creation in "processing" state, staged scan/commit coordination.

**Does not own:** File I/O, thumbnail generation, extraction logic, storage.

**Behavior:** Receives upload or import requests and coordinates the full pipeline. The job worker calls back into IngestionService's pipeline methods, which coordinate FileProcessingService, ThumbnailService, StorageService, and MetadataService in sequence. On completion, updates model status to `ready` or `error`.

Four entry paths:

- **Staged upload (scan phase):** `handleScan` receives one archive, creates an `ImportSession` (via ImportSessionService), and enqueues a scan job on the `import-scan` BullMQ queue. `handleMultipartScan` does the same for an explicit archive group, carrying either `combine` (independent complete archives extracted under collision-safe archive-name folders) or `split` (one recognized split ZIP or modern split RAR set, colocated and extracted as a unit) through the scan job. Split sessions use a selection-order-independent logical filename: the classic terminal `.zip`, the numbered set's base `.zip`, or `<base>.rar` derived from RAR part 1. The worker's `processScanJob` extracts the input, detects metadata heuristically, forces multipart `detected.modelCount` to `1`, and updates the session to `ready_for_review`. No model is created at this stage.

- **Staged upload (commit phase):** `handleCommit` locks the owned, active-library session row, resolves and synchronously validates effective metadata, revalidates any persisted `draftFileLayout` against the current authoritative scanned manifest, then atomically claims `ready_for_review` by creating the Model in `processing` state and transitioning the session to `committing` in one database transaction. Invalid metadata or layout rolls the transaction back, leaving the session reviewable and creating no model. Concurrent commit requests therefore cannot create duplicate models, and a draft proposal cannot race between draft resolution and the state transition. An explicit `batchMetadata` object in the commit request is authoritative for metadata; when the request omits it, the service reads the session's persisted `draftMetadata` under that lock. `draftFileLayout` is independent and remains effective in either case. After the transaction commits, it enqueues a commit job on the `import-commit` BullMQ queue; enqueue failure marks both the model and session `error`. The worker's `processCommitJob` expands the compact layout again, reads each staged file from its original `sourceRelativePath`, writes it to managed storage and persists its ModelFile record at the reviewed destination path, and explicitly persists the `Model` and `Images` root folder records even when one is empty. Thumbnail generation likewise reads an image from its original staged path while associating the generated thumbnail with the destination ModelFile. The worker then applies the effective `BatchUploadMetadata`, including configured field values from `metadata`; dedicated `artist` and `tags` properties override duplicate generic slugs. It publishes structured `ImportCommitProgress` throughout that pipeline: managed-storage transfer occupies 0–80%, followed by records at 85%, thumbnails at 90%, metadata at 95%, and completion at 100%.

- **Folder import:** `handleFolderImport` receives an `ImportConfig` (source path, pattern, strategy, and optional remote-source deletion). It uses PatternParser to validate and parse the hierarchy pattern and FileProcessingService to walk the directory. Local storage applies the selected hardlink, copy, or move strategy. Remote storage uploads each file, reads it back to verify byte size and SHA-256, and optionally deletes sources in a separate pass only after the entire job succeeds. Folder import retains its existing immediate behavior — it does not use the staged session model.

- **Existing-model manual upload:** `appendUploadToModel` extracts an uploaded archive or stages an uploaded loose file, appends the resulting manifest to an owned model, generates thumbnails, and recalculates model statistics. After the files have been appended successfully, it best-effort reads a root-level `metadata.json` with the same bounded reader used by staged scan detection and applies supported `modelName`, `description`, `artist`, `tags`, `metadata`, and `newCollectionName` values to the existing model. Missing, invalid, oversized, symlinked, or nested metadata files are ignored without failing the upload; metadata-application failures are likewise non-fatal.

### ImportSessionService

**Owns:** `import_sessions` table CRUD — creating sessions, updating their status and detected metadata, persisting independent metadata and file-layout review drafts, listing active sessions, ownership validation, and expanding a reviewed layout against a scanned manifest.

**Does not own:** File extraction (FileProcessingService), ingestion pipeline (IngestionService), storage cleanup.

**Behavior:** `create` inserts a session in `scanning` status with a 24-hour `expiresAt`. `update` patches status and any combination of `detected`, `manifest`, `stagingPath`, `modelId`, `draftMetadata`, `draftFileLayout`, and `error`. Migration `0013_add_import_session_draft_metadata.sql` adds nullable JSONB `draft_metadata`; migration `0016_add_import_session_draft_file_layout.sql` adds nullable JSONB `draft_file_layout` separately so an explicit metadata form submission cannot discard an assistant-reviewed organization plan. `updateDraftMetadata` shallow-merges draft fields while separately merging nested `metadata` and `options`; an explicit existing-collection choice removes a staged new-collection choice and vice versa. `updateDraftFileLayout` replaces the compact layout as one reviewed unit. `applyImportFileLayout` validates and expands that plan: exact-file mappings override prefix mappings, otherwise the longest matching source prefix wins, and an empty prefix can cover the archive root. Every scanned file must resolve to a unique, non-conflicting destination below exactly the `Model` or `Images` roots; image files must be below `Images`, printable model files below `Model`, and unsafe or nonexistent source/destination paths are rejected. Assistant proposal validation accepts only owned, active-library sessions in `ready_for_review`, and apply locks referenced sessions in deterministic ID order before writing either draft. `listActive` returns sessions in `scanning`, `ready_for_review`, `committing`, or `error` status for a given user and library. `getOwnedRow` fetches a session and throws `NOT_FOUND` if it doesn't exist or belongs to a different user. `toDto` maps the DB row to the `ImportSession` API shape (omitting `manifest` and `stagingPath`, but exposing `draftMetadata` and `draftFileLayout`). For list and detail reads, the service resolves a committing session's live progress through JobService. If the queue has not published valid structured progress or the lookup fails, the response remains available with a synthetic `queued`/0% value whose totals come from detected metadata when available. `commitProgress` is `null` for every non-committing status.

### FileProcessingService

**Owns:** Archive extraction and creation, folder directory walking, file type classification, basic metadata extraction from file contents and names.

**Does not own:** File storage, thumbnail generation, database record persistence.

**Behavior:** Given an archive file (zip, rar, 7z, tar.gz, tgz), an explicit multipart archive group, or a directory path, produces a structured manifest describing what was found: files with their relative paths, classified types, sizes, and any metadata extractable from filenames or structure. In `combine` mode every source must be an independent complete archive with a plain filename. Each archive is extracted beneath a folder derived from that filename, empty or dot-only folder names are rejected, folder collisions are resolved case-insensitively with `-2`, `-3`, and later suffixes, and the resolved folder must remain a strict descendant of the extraction root. In `split` mode the service validates either a contiguous classic `.z01` … `.z99` set plus one terminal `.zip`, a contiguous numbered `.zip.001` … `.zip.999` set, or a modern contiguous `<base>.partN.rar` set starting at part 1. Every set must use one case-insensitive base name; RAR members additionally require a safe base and consistent part-number padding. The service copies normalized member names into a temporary colocation directory, invokes the full 7-Zip extractor on the ZIP or RAR entry member so it can resolve the remaining colocated volumes, then removes the temporary directory. Before 7-Zip-based extraction it requests technical metadata and rejects absolute, drive-qualified, UNC, or parent-traversal paths plus symbolic links, hard links, and reparse entries. Link detection covers dedicated fields and Unix link modes or reparse markers reported through `Mode` or `Attributes`; extraction-reported paths outside the destination are also rejected. This manifest is what IngestionService uses to create ModelFile records and route files to storage. For assistant layout inspection, `extractManifestUrlCandidates` reads only bounded prefixes of text-like files and returns normalized HTTP(S) URL/path pairs rather than arbitrary document contents: at most 20 eligible files, 64 KiB per file, 512 KiB total, and 24 unique candidates. Unreadable files are skipped and Patreon candidates sort first. During commit, `copyManifestToStorage` reads `sourceRelativePath` when a reviewed destination differs and reports monotonic per-file and byte counters without making progress reporting a requirement for a successful storage write. For folder compression, `create7zArchive` invokes the bundled 7-Zip binary with the 7z container and explicit LZMA2 method; it archives the staging directory's children so it does not introduce an extra top-level folder.

Uses the **PatternParser** utility (located in `utils/pattern-parser.ts`) — a pure function that takes a user-defined hierarchy pattern string (e.g., `{Collection}/{metadata.Artist}/{model}`), validates it, and returns a structured representation. Validation rules: pattern must end with `{model}`, segments must be `{Collection}` or `{metadata.<fieldSlug>}`, and `{model}` cannot appear in the middle.

### StorageService

**Owns:** Blob storage and retrieval, path management within the managed storage root, deletion.

**Does not own:** Any knowledge of domain entities. It stores and retrieves bytes at paths.

**Interface:** `IStorageService` exposes store, buffered and streaming retrieval, copy, single and batch delete, and existence checks over backend-independent logical keys. `deleteMany` is the path for removing a model's files: it returns per-object failures instead of throwing, because callers run it after the database rows are already gone and one unreachable object must not strand the rest. `S3StorageService` implements it with `DeleteObjects` in batches of `S3_DELETE_BATCH_SIZE` (100) sent one at a time, which is MEGA S4's documented balance between delete throughput and contention with concurrent uploads; `LocalStorageService` loops, since the filesystem has no batch unlink. `store` accepts an optional observational callback with the bytes transferred for the current object; local and S3 implementations both report it, and callback failures never fail the underlying write. `store` returns a `StoreResult` carrying the backend's ETag and part size where it has them, which is what makes upload verification possible without a second request. `LocalStorageService` is the default. `S3StorageService` is selected with `STORAGE_BACKEND=s3` and applies the optional `S3_PREFIX` when translating a logical key to an object key.

**Rate limiting:** the S3 client uses `retryMode: 'adaptive'`, which adds a client-side rate limiter on top of the standard backoff — a throttled response slows every subsequent request rather than only retrying the one that was rejected. Object stores meter request rate (MEGA S4 serves 40–50 upload requests per second per account), and ingestion's fan-out is bursty enough to cross that on small files, where each object is a single `PutObject` instead of a multipart sequence. `maxAttempts` is 6 rather than the SDK default of 3, because under a rate limit a rejection is expected and self-resolving. `observeThrottling` in `s3-throttling.ts` wraps the deserializer so every throttled attempt is counted, including the ones a retry rescues, and logs a summary at most once per 30 seconds; without it adaptive backoff is silent and a metered deployment is indistinguishable from a slow network. All other services interact with this interface and do not construct filesystem paths, S3 requests, or public object URLs.

The S3 client accepts a custom endpoint, region, bucket, prefix, and path-style setting. Credentials come from the AWS SDK default credential chain rather than Alexandria-specific credential fields. Request checksum calculation and response checksum validation are both limited to `WHEN_REQUIRED`; uploads do not send server-side-encryption, ACL, or storage-class headers. This minimal request surface supports S3-compatible providers such as MEGA S4 as well as AWS S3.

Because a remote store's cost is dominated by per-request round trips, multi-file writes fan out through `mapWithConcurrency` up to `STORAGE_UPLOAD_CONCURRENCY`, and the client's socket pool is sized from that setting so it does not become the limiting factor. `uploadConcurrencyFor` keeps local storage sequential. `storeVerified` hashes a file as it streams out, yielding both its SHA-256 and its expected ETag, so an upload is confirmed without being read back; copies beyond the single-request limit use a server-side multipart copy rather than routing bytes through the backend.

S3 buckets remain private. `GET /files/thumbnails/:id.webp` and `GET /files/models/:modelId/*` authenticate the request, resolve the logical storage key from the database, and stream the object through Fastify. Alexandria does not expose presigned or provider-native URLs. Thumbnail responses use a stable ETag and a private one-year immutable cache policy; model-file responses use the file's stored SHA-256 as a strong ETag and retain their private one-day cache policy. Both routes return `304 Not Modified` when `If-None-Match` matches, and model-file responses also include the stored byte length.

In S3 mode, StorageService keeps a bounded persistent cache of thumbnail objects. Its default location is the reserved `<STORAGE_PATH>/.cache/s3-thumbnails` directory, with an optional dedicated path configured by `S3_THUMBNAIL_CACHE_PATH`. S3 remains the authoritative store: the cache accepts only logical keys in the `thumbnails/` namespace and is rebuildable, never a source of record. Thumbnail retrieval is read-through, concurrent misses for the same key are coalesced, and successful thumbnail stores are written through when possible. Cache files are published atomically and evicted by least-recently-used order when the configured `S3_THUMBNAIL_CACHE_MAX_BYTES` limit is exceeded. The limit defaults to 1 GiB; `0` disables the cache. Cache read, write, metadata, or eviction failures are otherwise logged or treated as misses. Mutations invalidate old cache bytes before changing S3 and persist a restart-safe marker when physical removal fails; only failure of both safeguards rejects the mutation before S3.

On startup, S3 mode performs `HeadBucket` validation before database migration and listening. Local-to-S3 migration is available through `npm run storage:migrate -w @alexandria/backend`; it walks the authoritative object tree beneath `STORAGE_PATH`, explicitly excluding the reserved cache directory, copies objects to the configured S3 backend in parallel, and verifies each upload from the hash computed while it streamed. Objects already present at the target are still read back, since nothing local records what an earlier run uploaded. It is restartable because already matching objects are skipped, and local authoritative files are retained for rollback. See `docs/STORAGE.md` for operations.

**Folder import storage behavior** depends on the configured backend:
- `HardlinkStrategy` — validates same-filesystem requirement, creates hardlinks into managed storage. Falls back to copy with a warning if hardlinking fails.
- `CopyStrategy` — copies files into managed storage. Safe default.
- `MoveStrategy` — moves files into managed storage. Destructive to originals.
- **Remote upload path** — when the configured storage backend is S3, uploads each source and verifies size plus SHA-256. Optional source deletion occurs after all models in the import succeed, never inline with uploads.

### ThumbnailService

**Owns:** Image resizing, webp conversion, thumbnail record creation.

**Does not own:** Storage (delegates to StorageService), knowledge of what model a thumbnail belongs to (receives a file reference, returns a thumbnail reference).

**Behavior:** Given an image file reference and storage path, generates webp thumbnails at defined sizes, stores them via StorageService, and returns Thumbnail records.

### SearchService

**Owns:** All query execution — browse, search, filter, sort, pagination, and cross-entity global search. This is the single entry point for "give me models matching criteria" and for the global search bar.

**Does not own:** Data indexing, data mutation. SearchService is read-only.

**Behavior:** Two public methods:

- `searchModels(params, libraryId, options?)` — accepts query parameters (text search, metadata filters, collection filter, sort, pagination cursor) plus an optional `SearchModelsOptions`. `options.ruleWhere` is a pre-compiled smart-collection SQL condition ANDed into the query. `options.applyDefaultStatus` (default `true`) controls the implicit `status = 'ready'` filter — smart collections suppress it when their rule tree already references `status`. Internally, `searchModels` builds its per-dimension filter SQL via `buildLeafCondition` from `rule-engine.ts`, the same function the rule compiler uses, so flat params and compiled rule trees produce identical SQL per dimension.

- `searchAll(params, userId, libraryId)` — cross-entity search. Calls `searchModels` for models (full-text), then filters in-memory against collections (by name substring, sorted by `modelCount`), artist values, and tag values (both by name substring, drawn from `listFieldValues`). Results for each entity type are limited to `params.limit` (default 6). Returns a `GlobalSearchResult`. Smart collections are not yet included in `searchAll` results — that union is deferred.

**Abstraction:** The search implementation is behind an interface. Postgres FTS is the MVP implementation. A future MeiliSearch or Typesense implementation can be swapped in without changing any callers.

### DuplicateScannerService

**Owns:** Detection and reporting of exact duplicate physical files, duplicate archive members, and exact duplicate models within one authenticated user's active library, persisted duplicate-review flags, library-scoped ignored duplicate identities, and reconciliation of those flags after file membership changes.

**Does not own:** File hashing, model/file deletion, or model merging. ModelService performs structural mutations and then delegates duplicate-flag reconciliation back to DuplicateScannerService.

**Behavior:** `scanDuplicates(libraryId)` considers only `ready` models that have at least one file. The route supplies the ownership-checked `request.libraryId` produced by `requireLibrary`, and concurrent requests for the same library share one in-flight scan. PostgreSQL aggregates every eligible model's complete sorted multiset of file hashes into one row per model; a second query returns file detail only for hashes that occur more than once in the same scope. Library-scoped ignored file hashes and whole-model fingerprints are removed from the report. This bounds transferred and retained detail to actual, non-ignored duplicate-file candidates instead of every stored file. Whole-model identity remains independent of file order while preserving repeated hashes: a model containing the same file twice does not match one containing it once. Filenames and relative paths participate in neither form of matching, and only file hashes or whole-model identities shared by at least two candidates are returned.

The scan separately selects stored files with supported archive extensions (`zip`, `rar`, `7z`, `tar.gz`, and `tgz`) and extracts each one in an isolated temporary directory through `FileProcessingService.processArchive`. That reuses the existing archive path and link safeguards and produces the member manifest and hashes without creating `ModelFile` rows. Unreadable or rejected archives are logged and skipped. Matching members are grouped only when they occur in different archive files; `scannedArchiveFileCount`, `scannedArchiveEntryCount`, and `archiveFileGroups` are returned as informational, read-only data. They do not participate in physical-file mark/ignore actions, which continue to use the existing `fileGroups` report and persistence paths.

File candidates are ordered by file creation time and file UUID, with owning-model creation time and model UUID as later tie-breakers. File groups are ordered by their oldest file's creation time, then hash and oldest file UUID. Whole-model candidates remain oldest-first by model creation time and UUID, and whole-model groups are ordered by their oldest model, with fingerprint as the final tie-breaker. PresenterService formats timestamps and assembles per-group and aggregate counts and two independent reclaimable-byte estimates. File-level savings can overlap whole-model savings, so clients must not add `fileReclaimableBytes` to `reclaimableBytes`.

`markDuplicates(libraryId)` marks every file in the current non-ignored scan, while `markDuplicateFileGroup(libraryId, hash)` marks only the selected current file group and preserves other explicit choices. A ready, non-empty model receives `models.is_duplicate = true` only when every current file in it is marked. `ignoreDuplicateFileGroup(libraryId, hash)` persists the selected file hash, then reconciles flags against the now-filtered scan so ignoring an already marked set clears its file and derived model flags. Both per-file-group methods reject a missing, stale, or already ignored hash as not found. There is no ignore-all service method or route. User-triggered mark and ignore actions run in retrying serializable transactions, and their flag update rechecks ready-library duplicate membership and ignore state in SQL, so an overlapping deletion or ignore cannot restore a stale flag. ModelService invokes preservation-oriented reconciliation after file-set mutations: it keeps marked files only while they remain members of a current, non-ignored duplicate set, never marks an unrelated set as a side effect, and recalculates model flags. Consequently, deleting one member of a two-file duplicate set clears the surviving file's mark and any model mark that no longer satisfies the all-files rule.

### ModelService

**Owns:** Model, ModelFile, and ModelFolder CRUD. Creating, reading, updating, and deleting Model records; managing file and persisted-folder relationships; and coordinating structural operations such as model merge and splitting one folder or a selected set of files into a new model.

**Does not own:** Metadata CRUD (delegates to MetadataService), collection membership, ingestion pipeline, search, storage implementation, or thumbnail generation. Structural operations may copy existing metadata relationships as part of their transaction. Structural file operations use StorageService's backend-independent copy/delete interface.

**Selected-file deletion behavior:** `deleteModelFiles` accepts 1–500 unique file IDs from an owned model in the active library. It locks the model to serialize file-membership aggregate updates, verifies the complete selection, captures file and thumbnail storage paths, deletes the file rows, recalculates model statistics, and reconciles duplicate-review flags in one transaction. A missing file aborts without deleting any of the selection, while a concurrent selection change produces a conflict and rolls back the transaction. After commit, batched deletion of the captured storage objects is best-effort, logs individual failures, and cannot change the successful database result.

**Duplicate consolidation behavior:** ModelService previews and confirms one source/target pair from the duplicate Tools pane. Both models are revalidated as owned, active-library, ready, non-empty, and exact equal sorted hash multisets; confirmation locks both rows before repeating that validation. It retains the target's file rows and deletes the source model, cascading source file records, folders, thumbnails, and relationships. Before deletion, source metadata fills only target-missing fields and source collection/tag memberships are unioned onto the target. Source file and thumbnail objects are deleted in a best-effort batch after commit. The preview and confirmed result expose every removed source file, thumbnail cleanup path, and relationship count, and no operation accepts multiple source models or applies globally.

**Split behavior:** The split endpoint accepts exactly one selection from an owned, ready model in the active library. `splitModelFolder` accepts a folder containing at least one file. Its files become the root contents of a new ready, `manual` model; descendant paths are rebased by removing the selected folder prefix, while persisted nested folders, including empty descendants, are preserved. `splitModelFiles` accepts 1–500 unique file IDs from the source model, moves all selected files into the same new model, and preserves each file's relative path. Existing ModelFile IDs and thumbnail records remain attached to their files. If the source model's selected preview is among the moved files, its preview selection and crop values transfer to the new model and are cleared on the source. Both models' file count and total size are recalculated. The new model receives the requested name and only the populated metadata values selected by field slug. The special `tags` slug copies tag memberships. Copied metadata remains on the source model; collection memberships, description, and other source provenance are never copied.

The service copies file and thumbnail objects to new model-scoped storage keys before opening the database transaction. In the transaction it locks and revalidates the owned source and selected files, plus the exact folder contents for a folder split, creates the new model, delegates the selected metadata and tag-membership copy to MetadataService, reassigns file rows and any applicable folder rows, updates storage keys and preview references, and recalculates both models' statistics. MetadataService rejects a selected field slug that no longer exists and holds key-share locks on resolved field definitions until the split commits, preventing a concurrent field deletion from creating a partial copy. A concurrent selection change produces a conflict and rolls back the database work, including metadata copies. Any pre-commit copy or transaction failure triggers best-effort removal of every object whose copy completed successfully. After a successful commit, deletion of the old storage objects is best-effort; a cleanup failure cannot roll back the committed split.

For a derived folder archive, `createModelFileAndRecalculateStats` inserts the `ModelFile` record and recalculates the model's file and byte totals in one database transaction.

### ModelFolderArchiveService

**Owns:** Orchestrating non-destructive compression of one model folder into a sibling 7z archive.

**Does not own:** Model ownership or library authorization (the route and ModelService), archive encoding (FileProcessingService), blob storage (StorageService), or model-file persistence (ModelService).

**Behavior:** Normalizes the requested and derived archive paths, serializes concurrent requests for the same model and folder, and admits at most one compression process at a time per backend instance. It resolves descendant files and explicit empty folders and rejects a missing folder. Before reading source objects, it rejects any file, folder namespace, or storage object already occupying `<folder-path>.7z`. It streams source objects through StorageService into an isolated temporary directory, delegates explicit LZMA2 archive creation to FileProcessingService, and stores and verifies the result through the configured storage backend. ModelService then records the archive as `application/x-7z-compressed` and updates model totals transactionally. The source folder is never changed. Failures before database persistence trigger best-effort deletion of the newly written archive object, and temporary data is always removed.

### ArchiveBrowserService

**Owns:** Read-only listing and single-entry download preparation for one stored archive model file.

**Does not own:** Model ownership and library scope (delegates to ModelService), archive format parsing or extraction safeguards (FileProcessingService), managed object access (StorageService), or persistence of extracted files.

**Behavior:** Resolves an archive file only after ModelService verifies the requested model belongs to the active library. It streams the managed archive into an isolated temporary directory and delegates extraction to FileProcessingService, so all existing ZIP, TAR.GZ, RAR, and 7z traversal/link protections apply. Listing returns safe files plus inferred parent directories. A requested download path is normalized, rejected when unsafe, then checked against a fresh manifest before opening the extracted file stream; a client cannot download an arbitrary temporary path. The temporary directory is removed after listing, on preparation failure, or when the download stream closes/errors. Neither operation writes `ModelFile` rows or changes the model.

### MetadataService

**Owns:** Metadata field definitions, metadata values on models, optimized storage routing for performance-critical field types.

**Does not own:** Model entity itself, search execution, presentation.

**Key architectural decision — uniform interface, specialized storage:** All metadata is accessed through MetadataService's API uniformly. Internally, MetadataService routes certain field types to optimized backing storage:
- **Tags** (type `multi_enum` with `isDefault: true`): stored in dedicated `tags` and `model_tags` tables for join performance.
- **All other fields**: stored in the generic `model_metadata` table.

No other service knows about this routing. To every consumer, tags are just another metadata field. If a future field type (e.g., Artist) needs optimized storage, MetadataService adds the optimization internally without API changes.

`MetadataService.validateFieldValue` is the single semantic validator used by direct metadata writes, AI proposal preview/apply validation, and staged-upload commit validation. It accepts `null` as removal; requires finite numbers and booleans for their respective types; accepts only parseable non-empty dates and HTTP(S) URLs; enforces string arrays and configured options for multi-enums; enforces configured options for enums; and applies `validationPattern` for text fields. Metadata strings are capped at 10,000 characters, arrays at 100 entries, and validation patterns at 512 characters. Patterns execute only through the non-backtracking RE2 engine; unsupported constructs are rejected and never fall back to native JavaScript regular expressions. Staged commits validate the complete effective metadata object synchronously inside the session-claim transaction before creating a model or changing session state.

Bulk tag additions accept one tag string or an array. MetadataService trims every name, requires 1–255 characters after trimming, rejects generated slugs longer than 255 characters, and removes case-insensitive duplicates before creating tags or memberships. The `add` action is valid only for the default Tags field; relationship insertion is conflict-safe, so an existing tag membership is not duplicated.

**Default fields** seeded on startup: Artist (text), Year (number), NSFW (boolean), URL (url), Pre-supported (boolean), Tags (multi-enum), and Source (text). These have `isDefault: true` and cannot be deleted. Source is filterable and browsable with `sortOrder: 6`; the idempotent startup seed adds it to existing installations without rewriting existing field order.

### CollectionService

**Owns:** Collection CRUD, parent-child nesting (tree operations), collection-model membership (add/remove models from collections).

**Does not own:** Model data, search, metadata.

**Boundary note:** CollectionService owns "add/remove model from collection." ModelService can read "what collections is this model in" for display purposes but does not mutate collection membership.

Collections are an organizational structure, not metadata. A model's relationship to a collection is about where you put it, not what it is. This is why collections remain a separate entity while Artist and Tags moved into the metadata system.

### BulkService

**Owns:** Coordination and scope enforcement for the public `/bulk/metadata`, `/bulk/collection`, and `/bulk/delete` endpoints.

**Does not own:** Metadata semantics, collection membership implementation, model persistence, or blob storage; it delegates those responsibilities to their domain services.

**Behavior:** Every public bulk route applies `requireAuth` followed by `requireLibrary`. BulkService canonicalizes 1–500 unique model IDs, locks and verifies that every model belongs to the authenticated user and active library, and performs metadata, collection, or database-delete work in one transaction. Metadata requests are limited to 1–25 operations. Collection requests also lock and verify the destination collection in the same user/library scope before mutation. Any invalid, un-owned, or wrong-library model or collection aborts the transaction before changes are made.

Bulk deletion captures the validated models' managed-file storage paths and deletes their database rows atomically. Only after that transaction commits does BulkService attempt each captured storage-object deletion. Storage cleanup is deliberately best-effort: failures are logged and do not roll back the committed database deletion or change the successful API response.

### SmartCollectionService

**Owns:** Smart collection CRUD, rule-tree validation, derived model result sets, unsaved rule-tree preview (dry-run).

**Does not own:** Rule compilation to SQL (delegates to `compileRuleTree` in `rule-engine.ts`), model querying (delegates to `SearchService.searchModels`).

**Behavior:** `create` and `update` call `resolveAndCompile` before any DB write, so a syntactically valid but semantically invalid tree (unknown metadata slug, illegal operator for a field's type) is rejected with a `VALIDATION_ERROR` rather than persisted. `getById` and `getModels` call `requireOwnedSmartCollection` first, which enforces ownership + library in a single query and returns `NOT_FOUND` on any mismatch. The list endpoint omits derived model counts to keep it cheap; `getById` and `create`/`update` compute a live count via `searchModels`.

`resolveAndCompile` resolves all metadata leaf conditions against live field definitions, validates operator/type compatibility using `LEGAL_OPERATORS_BY_METADATA_TYPE`, and decides whether to suppress `searchModels`' implicit `status = 'ready'` default (see `applyDefaultStatus` seam above).

### AI Assistant Services

The authenticated workspace mounts an assistant bubble in `AppShell`. A library-aware context provider supplies targets from the current page: one model on a detail page; up to 25 selected models, or the first 25 visible models when none are selected, in the pivot workspace; and one active upload when it is ready for review, otherwise up to 25 ready-for-review uploads, on the upload page. The **Organize model** starter is shown only when that context contains a staged-upload target; the other starters remain generally available. The assistant conversation is scoped to both the active library and the exact target set. A target or library change aborts in-flight chat, clears the prior conversation/proposal state, and suppresses stale chat or apply completions. The assistant may inspect/search models, collections, configured metadata fields with library-scoped known values, and active staged uploads; look up public web and image candidates; and prepare model or staged-upload changes. Model, collection, value, and upload reads remain scoped to the active library. It is split into focused services:

- **AiProviderService** owns user-scoped OpenAI-compatible provider configuration, encrypted API-key storage, default-provider selection, model discovery, and connection tests. Default-changing create, update, and delete transactions take a per-user PostgreSQL advisory lock, while the partial unique index remains the database backstop; concurrent requests cannot leave ambiguous defaults. Provider secrets are decrypted only for outbound provider requests and are never returned by the API; provider responses expose only `hasApiKey` and a short hint. Base URLs cannot contain embedded credentials and are DNS-resolved and checked against the provider-network policy when saved and before every request. Before each redirect hop, every resolved address is classified and the complete deduplicated vetted set is pinned into a short-lived Undici dispatcher. Undici may fail over among only those addresses without another DNS lookup; the request URL remains unchanged so HTTP Host and TLS SNI still identify the configured hostname, and the dispatcher is closed after the response is consumed or cancelled. Public endpoints require HTTPS; HTTP is accepted only when every resolved address is private/loopback and private providers are enabled. DNS resolution is capped at 3 seconds. Provider responses are capped at 2 MiB. Redirects are handled manually, revalidated, restricted to the original origin, and capped at three. Model discovery and connection tests use one 10-second request deadline; chat completions receive the assistant's remaining whole-request time and remain capped by its 90-second ceiling. Upstream failure bodies are not reflected into Alexandria API errors.
- **AiAssistantService** owns the bounded OpenAI-compatible tool loop. Read-only tools search the active library, inspect owned models, list collections, list configured metadata fields and their known library values, inspect active owned import sessions, and query web/image search adapters. Collection, field, known-value, and import-session list tool results are capped at 100 items and include `hasMore` when additional rows exist; normal public endpoints are unchanged. The organizer additionally uses `inspect_import_session_layout`, which accepts an offset cursor and a page size up to 100, returns authoritative manifest entries with `totalEntries` and a nullable `nextCursor`, and includes the separately bounded URL candidates described under FileProcessingService. It is restricted to an owned, active-library session in `ready_for_review`. Target IDs are ownership- and library-validated before any context is sent to the provider. Its change-capable tools are preview-only: `preview_changes` handles individualized model or upload-draft changes, while `preview_bulk_changes` is preferred when uniform metadata or collection operations apply to multiple current models or the whole active library. The bulk tool accepts only a symbolic `current_models` or `active_library` scope; the server resolves that scope and freezes the exact unique, owned model IDs in the canonical stored changes. An active-library request is rejected if it resolves to more than 500 models rather than silently applying to a partial library. Neither preview tool performs a domain mutation. For simple “fill metadata” tasks, the system instructions direct it to inspect filenames/files and configured fields, try the exact `{Artist Name} - {Date} - {Model Name}` filename convention after removing the archive extension, infer Source as the depicted character's originating franchise or work only when supported, and suggest tags and existing collections from known values. After reasonable research, the assistant chooses the best-supported Source result, clearly states uncertainty, and does not keep searching merely to eliminate uncertainty; genuinely weak or conflicting evidence leaves Source unset. For **Organize model**, it must inspect the complete paginated layout before proposing changes. It treats an exact extension-stripped `{Artist} - {YYYY-MM} - {Character}` title as artist, character, `YYYY` year, `YYYY-MM` date, and `MM` month evidence when matching configured fields exist; it uses `Character` as the model name, or `{Artist} - Unknown` when the artist is clear but no character is available. Case-insensitive `NSFW` anywhere in a file or folder path supports the NSFW option; exact normalized path tokens `pre`, `presupported`, `pre-supported`, or `supported` support the pre-supported option, while `unsupported` does not. A clearly evidenced Patreon URL is preferred over another extracted URL for a configured URL field. The layout creates exactly `Model` and `Images`, preserves image/render subtrees below `Images`, and groups printable files below `Model` by clearly evidenced variants such as Standard, NSFW, Extra Torso, Bust, or Presupported. Multiple credible URLs or unclear variant-folder paradigms cause a clarifying question instead of a proposal. Deterministic filename and path parses are untrusted hints, and research-derived values remain suggestions until previewed and applied. The assistant operates only on explicit current targets unless the provider deliberately selects the `active_library` bulk scope. Validated model IDs and staged-upload ID/version pairs are serialized in a separate guaranteed context block that contains no free-form text, so JSON escaping or detail truncation cannot remove a later target. Human-readable model and upload summaries are serialized independently with bounded free-form fields. Per-call, cumulative tool, provider-context, and assistant-response budgets bound resource use. The per-provider-response tool cap and whole-request tool cap are both 12. The loop permits at most 14 provider responses, leaving enough rounds for a small model to use all 12 tool calls one at a time, one oversized-batch repair, and a final synthesis. When only one tool call or one tool-capable provider response remains, an added instruction stops exploratory research and prompts the provider to create the best-supported review proposal or explain the remaining uncertainty. Once a proposal is created or the tool budget is exhausted, the next request immediately becomes tool-free synthesis. The final provider request is always tool-free. If that synthesis is empty or the request ceiling is exhausted, Alexandria returns a bounded useful fallback based on the proposal and sources already gathered instead of a maximum-provider-requests error. For the first provider response that exceeds its remaining tool allowance, no calls are executed and the service requests one repair. If the repaired response or a later response is still oversized, the service no longer fails the turn: it selects at most the remaining tool budget, executes exactly one proposal call in preference to reads when present, or reserves one slot for a later proposal when possible. Every unexecuted call receives a bounded skipped tool result so the provider transcript remains protocol-valid. If even that complete skipped-result transcript cannot fit the cumulative result or provider-context budget, the service returns bounded synthesis from the work already gathered. Each user is limited to 10 chat starts per minute and two concurrent chats. This limiter is deliberately process-local for the single-instance deployment, holds at most 10,000 user entries, and resets on restart; a shared limiter is required before running multiple backend replicas. Client disconnect cancellation is propagated through the assistant into provider and public-search fetches and combined with their existing deadlines. Provider resolution, context assembly, library/model/import-session tools, and proposal creation are also raced against cancellation and the remaining request deadline. The shared PostgreSQL pool has a 5-second connection-acquisition timeout, 45-second server statement timeout, and 50-second client query timeout, bounding underlying database work that cannot be actively cancelled by the race. Expected tool errors are bounded before being returned to the provider, while unexpected internal/tool errors are replaced with a generic message.
- **AiProposalService** owns proposal validation and application. It re-checks user and library ownership, expiry, pending status, referenced metadata fields, image files, collections, and ready-for-review import sessions at both preview and apply time. Bulk metadata changes support `set`, `add`, and `remove`, with `add` restricted to the default Tags field; bulk collection changes support `add` and `remove`. Bulk proposal creation canonicalizes the symbolic target into one or two stored changes whose sorted, unique model-ID snapshots are capped at 500. The same snapshot is revalidated and locked on apply, so later additions to or removals from the library do not alter the reviewed target set. The preview display records the server-derived scope, exact model count, and up to five model names. The UI renders that scope, count, name sample, and an “N more” remainder without displaying the frozen UUID list. `update_import_session` and `organize_import_session_files` proposals both carry the session ID, original filename identity guard, and exact `updatedAt` optimistic guard. The organizer carries an `ImportFileLayoutPlan`; preview validation expands it against the current scanned manifest and adds the exact file count plus up to five destination paths to `display.importSessionLayouts`. A changed timestamp rejects either kind of stale proposal before mutation. Applying a current metadata change merges `ImportSession.draftMetadata`; applying an organization replaces `ImportSession.draftFileLayout`. Both only change staged review state: neither commits, enqueues, moves a staged source file, or otherwise processes the upload. Preview validation and persistence share a transaction with operation-deadline statement limits and cancellation checks around the insert, preventing an abandoned chat from committing a late proposal. Apply deterministically locks all referenced model and import-session rows `FOR UPDATE`, fully revalidates through that same transaction executor, then conditionally claims and delegates approved actions to ModelService, MetadataService, CollectionService, and ImportSessionService. The claim, every bulk or individual domain write, and the final status transition share one transaction, so bulk application is all-or-nothing. Set/add/remove implementations are idempotent, and the proposal itself remains single-use after a successful apply. Preview responses also include server-resolved collection names, image filenames/thumbnail URLs, and layout summaries so the human review UI does not have to present opaque UUIDs or an unexpanded mapping.
- **WebSearchService** owns outbound public lookup and normalizes results into source cards. Text lookup uses the DuckDuckGo Instant Answer API; image lookup uses Wikimedia Commons. These are public, keyless services rather than configurable search providers. Requests time out after 7 seconds and response bodies are capped at 1 MiB. A failed lookup is returned to the assistant as an unavailable tool result so the rest of the conversation can continue. It never imports a remote image into managed storage or mutates library data: a public image URL is a research candidate only, while a cover-image proposal must reference an image file that already belongs to the model. The frontend may load a returned Wikimedia thumbnail when it renders the source card.

Provider configuration is user-scoped, while proposals are scoped to both user and active library. Chat transcripts are client-session state and are not persisted in this version. Messages, supplied history, model/import-session target context, and tool results needed for a turn are sent to the selected external provider, so operators must treat provider selection as a data-disclosure boundary.

`AI_ENCRYPTION_KEY` supplies the key material used to encrypt provider API keys at rest with AES-256-GCM. Production startup fails when it is absent, shorter than 32 characters, equal to `SESSION_SECRET`, or one of the checked example placeholders. It must be a separate, stable secret; changing it makes already-stored provider credentials unreadable. Development falls back to `SESSION_SECRET` when it is unset, but setting a distinct value is recommended in every environment. Docker Compose requires and passes the variable to the backend.

Provider base URLs are user-configured and contacted from the backend, so they are an SSRF boundary. `AI_ALLOW_PRIVATE_PROVIDER_URLS` defaults to `false` in production and `true` outside production; Docker Compose passes it with a secure default of `false`. Enabling it permits loopback and RFC1918/unique-local providers for intentional LAN or same-host deployments. Link-local addresses, cloud-metadata hosts/addresses, multicast, reserved targets, IPv4-compatible translation addresses, NAT64 prefixes, 6to4, Teredo, and ISATAP remain blocked even when private providers are enabled. DNS pinning prevents a hostname from being re-resolved to a different address between validation and connection. Only trusted OpenAI-compatible endpoints should be configured.

### AuthService

**Owns:** User CRUD, password hashing, authentication, session creation and validation.

**Does not own:** Authorization or permissions (future scope).

**MVP scope:** Single-user local auth with email and password. Session-based. The User schema reserves columns for future OIDC/OAuth integration but the wiring is not built in MVP.

### UploadService

**Owns:** Chunked upload session management. Tracks in-flight upload sessions in memory, stores individual chunks to a temporary directory, and assembles them into files for handoff to IngestionService. Multipart grouping remains an explicit request-level concern; UploadService does not infer relationships between uploads.

**Does not own:** Ingestion pipeline, storage, database.

**Behavior:** `initUpload` creates a session with a UUID, a temporary chunks directory, a 2-hour expiry, and an `uploading` lifecycle. Chunk receipt, abort, and completion are serialized by per-session promise locks; multi-session assembly acquires locks in stable upload-ID order. `receiveChunk` streams each request into a bounded pending file. The accepted sizes of all other chunks plus the pending chunk cannot exceed the declared `totalSize`; a successful pending write atomically replaces that chunk index, while a failed retry deletes only the pending file and preserves the prior chunk. `abortUpload` transitions an `uploading` session to `aborted`, removes its temporary directory, and deletes it from memory. Assembly atomically claims a session or complete group as `assembling`; after every size check succeeds it marks and removes them as `consumed`. Any group assembly failure removes assembled temporary files and returns all still-present members to `uploading`, so no partial group is consumed. Expiry cleanup skips active or queued locks and purges unlocked expired sessions on a 10-minute interval. IngestionService removes assembled input files when multipart validation or queueing fails, and the scan worker removes source files after either scan success or failure; failed scans also remove the extraction directory. FileProcessingService always removes the temporary colocation directory used for split ZIP or RAR parts.

### JobService

**Owns:** BullMQ queue management, job creation, status tracking, retry logic, progress reporting.

**Does not own:** Job execution logic. Workers call back into domain services.

**Behavior:** Provides a clean interface for enqueuing jobs, querying job status, and managing retries. IngestionService uses it to enqueue processing jobs. The worker processes invoke IngestionService pipeline methods. Import-commit jobs use the import session ID as their BullMQ job ID, so `getImportCommitProgress(sessionId)` can retrieve and validate the structured progress deterministically without persisting a separate job-ID column on the session.

### PresenterService

**Owns:** API response payload assembly, view-specific data shaping, thumbnail URL resolution, file tree construction from flat relative paths.

**Does not own:** Data persistence, querying, business logic.

**Behavior:** Consumes data from ModelService, MetadataService, CollectionService, and SearchService. Produces view-ready response payloads shaped for specific API endpoints. Route handlers call PresenterService to build their response — they do not assemble responses themselves.

**View builders:**
- `buildModelCard(model)` → compact payload for grid/list views
- `buildModelCardsFromRows(rows, modelIds)` → batch assembly for SearchService results
- `buildModelDetail(model)` → full payload for detail page
- `buildFileTree(modelFiles)` → nested tree structure from flat relative paths
- `buildCollectionDetail(collection)` → collection with children and model count
- `buildCollectionList(userId, params)` → all collections for a user, with optional depth expansion
- `buildMetadataFieldList(fields)` → field definitions with value counts
- `buildDuplicateScanResult(scan)` → whole-model and file duplicate groups, summary counts, and independent reclaimable-byte estimates

---

## Frontend: Pivot Workspace

The Pivot Workspace is the primary browsing interface introduced in P1, replacing the previous Sidebar + Header + LibraryPage layout.

### Layout

The application shell (`AppShell`) is a full-height flex row:

```
┌──────────────┬──────────────────────────────────────────┐
│  PivotRail   │             <Outlet>                      │
│  (272 px,    │  PivotPage → PivotMain                   │
│   fixed)     │  ModelDetailPage, CollectionDetailPage,   │
│              │  UploadPage, SettingsPage, ToolsPage      │
└──────────────┴──────────────────────────────────────────┘
```

`PivotRail` is permanently mounted for all authenticated routes. The old `Sidebar.tsx` and global `Header.tsx` components were deleted; their responsibilities moved into the rail and PivotMain's top bar respectively.

### PivotRail

The rail contains, top to bottom:

1. **Library header** — brand mark plus the active library switcher. Selecting another owned library navigates to that library's `/lib/:id` workspace; the switcher also links to the All-Libraries home.
2. **AxisPicker** — a 2-column button grid for selecting the active axis. Collections, Artists, Tags, and Smart Collections are always present; every metadata field marked `isBrowsable` is also exposed as an axis (Artist and Tags reuse their dedicated axes instead of appearing twice).
3. **AxisFacetBody** — a scrollable list for the active axis. Shows the collections tree, smart collections, or the values and model counts for the selected metadata dimension, each pulling from the appropriate backend endpoint.
4. **UserMenu** — pinned footer with user avatar, display name, theme toggle, library-relative Tools and Settings links, and Log out. Tools navigates to `/lib/:id/tools` for the active library.

### Axes

The "axis" is the currently-selected browse dimension. It is stored in the URL as `?axis=` (e.g., `?axis=artists`). Dynamic metadata axes use `metadata:<slug>` (for example, `?axis=metadata:source`). The default axis is `collections`, which is omitted from the URL for clean links.

The axis is **pure UI state**. It is kept out of the React Query key and does not affect the API request made by `useModelResults`. Changing the axis reshapes the rail and the context header but does not refetch models unless the axis selection also changes the active filter (e.g., selecting a collection updates `?collectionId=`).

The fixed and dynamic axes behave as follows:

| Axis | Rail body | Active filter set |
|------|-----------|-------------------|
| `collections` | Collections tree | `collectionId` query param |
| `artists` | Artist values + model counts | `meta_artist` query param |
| `tags` | Tag values + model counts | `tags` query param |
| `smart` | Saved smart collections | `smartCollectionId` UI selection; the selected collection supplies the model query |
| `metadata:<slug>` | Values + model counts for a browsable metadata field | `meta_<slug>` query param |

The picker derives dynamic axes from `GET /metadata/fields`, preserving the endpoint's field-definition order (`sortOrder`, then creation time) and including only definitions with `isBrowsable: true`. The dedicated Artist and Tags axes remain responsible for those default fields because Tags uses its optimized storage and filter path. Other metadata axes use `GET /metadata/fields/:slug/values` and the existing generic metadata-filter contract.

### useModelFilters

`useModelFilters` (`apps/frontend/src/hooks/use-model-filters.ts`) is the single source of truth for all URL-backed filter state. It reads from and writes to `URLSearchParams`. It exposes:

- `filters` — the filter object passed to the React Query key.
- `toApiParams(cursor?)` — converts filters to the `ModelSearchParams` shape for the API call.
- `axis` / `setAxis` — the active pivot axis; not in `filters` and not in the React Query key.
- `activeAxisValue` — the currently-selected value within the active axis.
- Setter helpers for each filter dimension.

Metadata filters use a `meta_<slug>` prefix in the URL to namespace them (e.g., `?meta_artist=Maker+Name`).

### useModelResults

`useModelResults` (`apps/frontend/src/hooks/use-model-results.ts`) is the shared data engine for all view modes. It wraps a TanStack Query `useInfiniteQuery` keyed on `filters` (not `axis`), uses `getNextPageParam` to thread cursors, and sets up an `IntersectionObserver` on a sentinel `div` to trigger `fetchNextPage` automatically as the user scrolls. The hook exposes `models`, `total`, loading/error flags, and `sentinelRef`.

### PivotMain

`PivotMain` is the right-hand content area mounted at the `/` route (via `PivotPage`). It composes:

1. **Top bar** — `Breadcrumb` (left), search input, Upload link (right).
2. **Context header** — axis icon badge, context title (e.g., "All Collections", the selected artist name, or selected tags), total model count, View Switch, and a bulk-select toggle.
3. **Results region** — renders one of three views based on the `view` display preference.

### View Modes

Three view modes are available, selected via `ViewSwitch` and persisted in `localStorage` under the key `displayPrefs`:

| Mode | Component | Description |
|------|-----------|-------------|
| `grid` | inline card grid in PivotMain | Responsive auto-fill grid of `ModelCard` components |
| `list` | `ModelList` | Dense row view: thumbnail, name, artist, year, file count, size, status, tags |
| `group` | `ModelGroupView` | Models under sticky group headers keyed by the active axis |

The `showThumbnails` preference (also in `displayPrefs`) toggles thumbnail display in list and group views.

**Group view limitation:** For `axis=collections`, per-collection grouping requires collection membership on `ModelCard`, which the API does not currently return. Group view renders a single group for the collections axis. For `artists`, `tags`, and dynamic metadata axes, grouping runs client-side on loaded models; group counts reflect loaded models only and will grow as infinite scroll loads more pages. A dynamic metadata axis groups each model by the field's complete display value and puts models without a value in a `No <field name>` group.

### Bulk merge

`components/models/BulkActions.tsx` — the bulk-action bar `PivotMain` mounts over the results region — shows a **Merge** action once two or more models are selected. It opens `components/models/MergeTargetDialog.tsx`, which lists the selection and asks which model to keep; every other ready selection becomes a source for a single `POST /models/:targetId/merge` request. No target is preselected, since the sources are deleted once the merge succeeds.

The dialog mirrors three server-side constraints rather than discovering them through a failed request. The endpoint rejects any model that is not `ready`, so non-ready selections render as ineligible, are excluded from the request, and are reported as a skip count. `mergeModelsSchema` caps sources at 100, so a larger selection blocks with the number to deselect. And because merging needs at least two ready models, a selection that cannot reach two blocks as well.

Selection outlives filter and search changes, so a selected model is not guaranteed to still be on the caller's loaded page. The dialog names candidates from the models the caller already has and fetches only the strays. If that fetch fails — a selected model deleted elsewhere, say — merging is blocked instead of silently folding in the subset that did resolve.

On success the dialog drops its own `merge-selection` lookups and the detail-page dialog's `merge-candidates` searches from the cache, since those hold models the merge just deleted, and invalidates the model, collection, field-value, search, and smart-collection query families whose contents or counts the merge changed.

### Navigation

Authenticated workspace routes are rooted at `/lib/:id`. They include the library pivot at `/lib/:id`, model and collection detail routes, upload and search, smart-collection composition, `/lib/:id/settings`, and `/lib/:id/tools`. The UserMenu exposes Tools beside Settings; the Tools page keeps navigation and API requests within the active library. `/` is the authenticated All-Libraries home.

The standalone collections route remains available beneath the library workspace for direct navigation and collection-detail links, although collections are primarily browsed as a pivot axis rather than through a persistent rail link.

---

## Frontend: Upload Page

`UploadPage` exposes three upload methods as tabs: **Archive upload**, **Multi-part archive**, and **Server folder import**. Ordinary multi-select in Archive upload preserves the one-archive/one-session behavior. The Multi-part archive tab is the explicit grouping boundary and creates one review session from 2–100 selected files.

`MultipartArchiveUpload` (`components/upload/multipart-archive-upload.tsx`) requires the user to select one of two modes. **Combine archives** accepts independent complete `.zip`, `.rar`, `.7z`, `.tar.gz`, or `.tgz` archives and preserves each archive under a separate archive-named folder. **Split archive** accepts a complete classic `.z01` … `.zip` set, numbered `.zip.001` … set, or modern `<base>.part1.rar` … `<base>.partN.rar` set. Client validation checks count, non-empty files, the 5 GB per-file limit, filename length, supported extensions, one naming scheme and base name, duplicate part numbers, and contiguous numbering from part 1. Modern RAR sets also require consistent part-number padding. The backend repeats the security- and integrity-relevant validation and derives a stable logical filename from the split set rather than selection order. The review queue always describes the result as one model, matching the forced multipart `modelCount`.

The frontend initializes and uploads each file sequentially through the chunked protocol, reports byte-weighted progress across the group, and completes the group with the ordered upload IDs plus its selected mode. Ordinary and grouped uploads each own an `AbortController`; its signal is threaded through initialization, chunk XHRs, and retry backoff so cancellation stops both an active transfer and a pending retry delay. Immediately before completion, the client checks the signal and enters an explicit, non-cancellable **Finalizing** phase. The completion request is deliberately sent without that signal and with the library ID captured when the upload began, so a late cancellation or library switch cannot make server-side completion ambiguous. Progress and error handlers verify that the signal and controller are still current before mutating state, suppressing stale callbacks after cancellation. Once any upload IDs have been initialized, cancellation or another error before or around completion sends best-effort `DELETE /models/upload/:uploadId` cleanup requests for those IDs while preserving the original error; a cleanup request may find that completion already consumed the upload.

Every ordinary in-flight row exposes its own Cancel control while uploading and replaces it with a Finalizing label during completion. `UploadPage` keeps all three upload-method panels mounted and hides inactive panels, so switching tabs does not cancel active transfers. It also keeps the same `DropZone` mounted when a newly created review session changes it from the full to compact layout, so other concurrent upload rows and their controllers survive that transition. The grouped uploader exposes one Cancel control for the whole operation until Finalizing; cancellation resets its progress and error state but retains the selected files and mode for a retry. A successful grouped completion clears the selection and, when the originating library is still active, switches back to Archive upload and selects the single new review session in the queue.

The existing import-session list query continues to poll every two seconds while any session is non-terminal. Committing rows now carry `commitProgress`, which the queue and review pane render as a phase label, percentage, transferred bytes, completed files, and current filename. A defensive indeterminate state is used when progress is absent. The review pane also keeps its existing two-second model-status poll, but a model that becomes `ready` before the non-fatal metadata step finishes is not presented as complete while session commit progress is still active. When a ready-for-review upload is in assistant context, the assistant bubble exposes the staged-upload-only **Organize model** starter. An organization proposal card renders the compact root/prefix/exact-file mappings and the server-resolved file count with up to five sample destination paths; accepting the card only saves the staged layout, so the user must still press the upload commit action.

---

## Frontend: Model Detail Page (P2)

The Model Detail page (`pages/ModelDetailPage.tsx`) was fully redesigned in P2. It fetches both `GET /models/:id` and `GET /models/:id/files` in parallel and composes three top-level regions:

1. **Header** — a back link to the library plus `ModelBreadcrumb`, which renders `Library › <Collection> › <Model name>`. The collection crumb is a live navigation link; the model name is the current-page marker. The collection crumb is omitted when the model belongs to no collections.

2. **Hero column** — the existing `ImageGallery` plus a "View in 3D" button. The button is hidden when the model has no STL files. When the model has multiple STLs the button opens the viewer on the first file in tree order; per-file 3D affordances in the file tree open a specific file.

3. **Tabbed right panel** — `ModelDetailPanel` hosts `PanelTabs` (a full-width segmented control) with three tabs: Info (model name, description, metadata), Collections, and Files (the file tree). The panel is `380–420 px` fixed width alongside the hero column at `lg:` breakpoint and stacked on smaller screens.

### ModelBreadcrumb

`components/models/ModelBreadcrumb.tsx` renders the three-level hierarchy breadcrumb. It accepts the model's primary collection (`CollectionSummary | null`) and the model name. The intermediate collection crumb links to `/collections/:id`. Stylistically it mirrors the pivot workspace `Breadcrumb` but uses real navigation links.

### ModelHero

`components/models/ModelHero.tsx` wraps `ImageGallery` and the "View in 3D" action. It receives `stlFiles: StlFileRef[]` collected from the file tree and calls `onOpenViewer(primaryStl)` when the button is clicked.

### ModelDetailPanel and PanelTabs

`components/models/ModelDetailPanel.tsx` is the tabbed right panel. `components/models/PanelTabs.tsx` is the generic full-width segmented control it uses. `PanelTabs` is typed with a string union for tab values and accepts icon components typed as `React.ComponentType<{ className?: string }>` (see the gotcha note in the Conventions doc).

The Files tab exposes file and folder organization actions from each tree node. A folder's **Compress to 7z** action creates a sibling archive and refreshes the detail and file-tree queries after completion; the original folder remains available. The Collections tab lists the model's current manual-collection memberships and can add the model to one or more additional collections without removing existing memberships. The browse bulk-action bar makes the same distinction explicit: **Add to collection** preserves existing memberships, while **Move** replaces them.

The detail page also owns a per-model `MergeModelsDialog`, which keeps the current model as the merge target and searches the library for sources. The browse bar's bulk merge (see Pivot Workspace → Bulk merge) inverts that: the sources are already chosen and the dialog asks which one to keep.

The Files tab passes folder- and selected-file split callbacks into `FileTree`. Each directory's action menu can open `SplitFolderDialog`, prefilled with the folder name, to create a model from that directory's contents. Selection mode exposes the same dialog for 1–500 selected files and moves the selection together without rebasing their relative paths. The dialog lists each populated source metadata field, including Tags, with its current display value. All fields start unchecked; the user can select fields individually or use the select-all and clear-all controls, and the dialog sends the selected field slugs with the split request. It makes clear that collection memberships are never copied and remains open after a failed request so the user can retry. On success, `ModelDetailPage` invalidates the source model, source file tree, model browse, and search queries, shows the moved-file count, and navigates to the newly created model.

### 3D Viewer

The 3D viewer is an in-browser STL renderer built on `three` + `@react-three/fiber` + `@react-three/drei`. It is composed of two layers:

- `ModelViewer3DModal` — the dialog shell. Manages the active STL selection, a file switcher strip when the model has multiple STLs, and an error boundary around the scene. It loads the scene module via `React.lazy`.
- `ModelViewer3DScene` — the actual r3f scene: a `Canvas` with ambient and directional lights, `OrbitControls`, and a `Bounds` wrapper that auto-fits the loaded geometry. This is the **only module that imports `three`** — the rest of the app does not touch three.js.

Because `ModelViewer3DScene` is lazy-loaded, Vite emits three.js as a separate async chunk (~924 KB). The chunk is fetched only when the viewer first opens. Nothing in the critical path is blocked.

### lib/model-files.ts

`lib/model-files.ts` contains three pure helper functions for working with STL files from the file tree:

- `collectStlFiles(tree, modelId)` — walks a `FileTreeNode[]` tree depth-first and returns a `StlFileRef[]` for every STL file. It reconstructs each file's relative path from the tree (since `FileTreeNode` nodes have only a `name`, not a `relativePath`) by accumulating ancestor directory names during the walk.
- `getPrimaryStl(stls)` — returns the first `StlFileRef` or `null`.
- `makeStlRef(modelId, segments)` — builds a `StlFileRef` from path segments, including the `/api/files/models/:modelId/:path` URL. This is the single source of truth for STL file URLs in the frontend.

`StlFileRef` is defined in this module: `{ name: string, relativePath: string, url: string }`. It is a frontend-only type and does not exist in shared types.

---

## API Design

### Conventions

- **Routing:** Hybrid — flat routes for top-level resources, nested where hierarchy is real and single-parent (e.g., `/models/:id/files`).
- **Envelope:** Every response uses `{ data, meta, errors }`. No exceptions.
- **Pagination:** Cursor-based. `meta` includes `total`, `cursor` (null on last page), and `pageSize`.
- **Auth:** Session cookie on every request. Routes validate via AuthService middleware.

### Route Map

**Models**
| Method | Route | Purpose | Service Chain | Library-scoped |
|--------|-------|---------|---------------|---------------|
| GET | /models | Browse/search with filters | SearchService → PresenterService | Yes |
| GET | /models/:id | Model detail | ModelService → PresenterService | Yes |
| GET | /models/:id/files | File tree | ModelService → PresenterService | Yes |
| POST | /models/:id/files/upload | Append loose files or archive contents; import root metadata.json when present | IngestionService → FileProcessingService → StorageService + ModelService + MetadataService | Yes |
| GET | /models/:id/files/:fileId/archive | List a stored archive's safe contents | ArchiveBrowserService → ModelService + StorageService + FileProcessingService | Yes |
| GET | /models/:id/files/:fileId/archive/download | Stream one validated archive entry | ArchiveBrowserService → ModelService + StorageService + FileProcessingService | Yes |
| POST | /models/:id/folders/compress | Create a non-destructive sibling 7z archive | ModelFolderArchiveService → ModelService + FileProcessingService + StorageService | Yes |
| POST | /models/upload | Upload archive → scan (returns sessionId) | IngestionService → ImportSessionService → JobService | Yes |
| POST | /models/upload/init | Initiate chunked upload session | UploadService | No |
| POST | /models/upload/multipart/init | Initiate one chunked member of a multipart group | UploadService | No |
| PUT | /models/upload/:uploadId/chunk/:index | Upload a single chunk | UploadService | No |
| DELETE | /models/upload/:uploadId | Abort and clean up a chunked upload session | UploadService | No |
| POST | /models/upload/:uploadId/complete | Assemble chunks → scan (returns sessionId) | UploadService → IngestionService → JobService | Yes |
| POST | /models/upload/multipart/complete | Assemble an explicit archive group → one scan session | UploadService → IngestionService → FileProcessingService → JobService | Yes |
| POST | /models/import | Folder import (immediate; no staged session) | IngestionService → JobService | Yes |
| GET | /models/import-sessions | List active staged sessions | ImportSessionService | Yes |
| GET | /models/import-sessions/:id | Poll a single session | ImportSessionService | No (userId) |
| POST | /models/import-sessions/:id/extract | Extract a nested staged archive | IngestionService → FileProcessingService | Yes |
| POST | /models/import-sessions/:id/files | Append loose files to a staged model | IngestionService → FileProcessingService | Yes |
| POST | /models/import-sessions/:id/commit | Commit session → create model | IngestionService → JobService | Yes |
| DELETE | /models/import-sessions/:id | Discard session + staged files | IngestionService | No (userId) |
| GET | /models/:id/status | Processing status | ModelService | Yes |
| PATCH | /models/:id | Update model | ModelService → PresenterService | No (userId) |
| POST | /models/:id/files/delete | Atomically delete selected files, then best-effort clean captured storage objects | ModelService → PresenterService + StorageService | Yes |
| POST | /models/:id/folders/split | Move one folder or selected files into a new model | ModelService → StorageService | Yes |
| DELETE | /models/:id | Delete model + files | ModelService → StorageService | No (userId) |

"Library-scoped" means the route applies the `requireLibrary` preHandler and scopes its read or write to `request.libraryId`. Routes marked `No (userId)` enforce ownership but do not use the active library. Read/detail model routes and the folder-compression mutation enforce active-library scope; selected-file deletion and folder splitting do the same for their source model. The top-level `PATCH` and `DELETE` model mutations remain owned by `userId` only.

**Collections**
| Method | Route | Purpose | Service Chain | Library-scoped |
|--------|-------|---------|---------------|---------------|
| GET | /collections | List (with depth param) | CollectionService → PresenterService | Yes |
| GET | /collections/:id | Single collection | CollectionService → PresenterService | No (userId) |
| GET | /collections/:id/models | Models in collection | SearchService → PresenterService | Yes |
| POST | /collections | Create | CollectionService | Yes |
| PATCH | /collections/:id | Update | CollectionService → PresenterService | No (userId) |
| DELETE | /collections/:id | Delete (not its models) | CollectionService | No (userId) |
| POST | /collections/:id/models | Add model(s) | CollectionService | No (userId) |
| DELETE | /collections/:id/models/:modelId | Remove model | CollectionService | No (userId) |

**Smart Collections**
| Method | Route | Purpose | Service Chain | Library-scoped |
|--------|-------|---------|---------------|---------------|
| GET | /smart-collections | List (no model counts) | SmartCollectionService | Yes |
| POST | /smart-collections | Create | SmartCollectionService | Yes |
| GET | /smart-collections/:id | Single collection (with model count) | SmartCollectionService → SearchService | Yes |
| PATCH | /smart-collections/:id | Update name/description/definition | SmartCollectionService | Yes |
| DELETE | /smart-collections/:id | Delete | SmartCollectionService | Yes |
| GET | /smart-collections/:id/models | Derived model result set | SmartCollectionService → SearchService | Yes |
| POST | /smart-collections/preview | Dry-run unsaved rule tree | SmartCollectionService → SearchService | Yes |

All smart-collection by-id routes enforce ownership via `requireOwnedSmartCollection` in addition to the library scope from `requireLibrary`.

**Metadata**
| Method | Route | Purpose | Service Chain | Library-scoped |
|--------|-------|---------|---------------|---------------|
| GET | /metadata/fields | List all field definitions | MetadataService → PresenterService | No |
| POST | /metadata/fields/validate | Validate and normalize a metadata map without mutation | MetadataService | No |
| POST | /metadata/fields | Create custom field | MetadataService | No |
| PATCH | /metadata/fields/:id | Update field definition | MetadataService | No |
| DELETE | /metadata/fields/:id | Delete (not defaults) | MetadataService | No |
| GET | /metadata/fields/:slug/values | Known values + counts (within library) | MetadataService → PresenterService | Yes |
| PATCH | /models/:id/metadata | Set/update metadata | MetadataService | No (userId) |

**Auth**
| Method | Route | Purpose | Service Chain |
|--------|-------|---------|---------------|
| POST | /auth/login | Authenticate | AuthService |
| POST | /auth/logout | End session | AuthService |
| GET | /auth/me | Current user | AuthService |
| PATCH | /auth/me | Update profile | AuthService |

**AI Assistant**
| Method | Route | Purpose | Service Chain | Auth required | Library-scoped |
|--------|-------|---------|---------------|---------------|----------------|
| GET | /ai/providers | List the user's provider configurations | AiProviderService | Yes | No (userId) |
| POST | /ai/providers | Create a provider configuration | AiProviderService | Yes | No (userId) |
| PATCH | /ai/providers/:id | Update an owned provider | AiProviderService | Yes | No (userId) |
| DELETE | /ai/providers/:id | Delete an owned provider | AiProviderService | Yes | No (userId) |
| POST | /ai/providers/:id/test | Test an owned provider via model discovery | AiProviderService | Yes | No (userId) |
| GET | /ai/providers/:id/models | Discover an owned provider's models | AiProviderService | Yes | No (userId) |
| POST | /ai/chat | Run one library-assistant turn | AiAssistantService → AiProviderService; tool calls may use SearchService, ModelService → PresenterService, CollectionService, MetadataService, ImportSessionService, WebSearchService, or AiProposalService | Yes | Yes |
| POST | /ai/proposals/:id/apply | Apply an exact stored preview once | AiProposalService → ModelService / MetadataService / CollectionService / ImportSessionService | Yes | Yes |

All provider routes apply `requireAuth` and enforce provider ownership in `AiProviderService`; they do not apply `requireLibrary` because provider settings belong to a user rather than one library. Chat and proposal application apply `requireAuth` followed by `requireLibrary`. `AiAssistantService` passes the resolved user and library scope through every library/model tool, and `AiProposalService` revalidates both scopes before atomically claiming an apply request.

**Files (Authenticated Proxy)**
| Method | Route | Purpose | Service Chain |
|--------|-------|---------|---------------|
| GET | /files/thumbnails/:id.webp | Serve thumbnail | StorageService |
| GET | /files/models/:modelId/* | Serve model file | StorageService |

**Search**
| Method | Route | Purpose | Service Chain | Library-scoped |
|--------|-------|---------|---------------|---------------|
| GET | /search | Cross-entity search (models, collections, artists, tags) | SearchService | Yes |

**Tools**
| Method | Route | Purpose | Service Chain | Library-scoped |
|--------|-------|---------|---------------|---------------|
| GET | /tools/duplicates | Report exact duplicate physical files, archive members, and ready models with identical complete file-hash multisets | DuplicateScannerService → PresenterService | Yes |
| POST | /tools/duplicates/mark | Mark every file in the current non-ignored scan | DuplicateScannerService | Yes |
| POST | /tools/duplicates/file-groups/:hash/mark | Mark one current duplicate file set | DuplicateScannerService | Yes |
| POST | /tools/duplicates/file-groups/:hash/ignore | Ignore one current duplicate file set and clear its flags | DuplicateScannerService | Yes |
| POST | /tools/duplicates/consolidate/preview | Preview one exact-duplicate model consolidation | ModelService | Yes |
| POST | /tools/duplicates/consolidate | Confirm one exact-duplicate model consolidation | ModelService → StorageService | Yes |

**Bulk Operations**
| Method | Route | Purpose | Service Chain | Library-scoped |
|--------|-------|---------|---------------|----------------|
| POST | /bulk/metadata | Metadata changes on multiple models | BulkService → MetadataService | Yes |
| POST | /bulk/collection | Add/remove models or move them by replacing all existing collection memberships | BulkService → CollectionService | Yes |
| POST | /bulk/delete | Atomically delete model rows, then best-effort clean captured storage objects | BulkService → ModelService → StorageService | Yes |

---

## Decision Log

Decisions recorded here are intentional and should not be reversed without explicit discussion and an update to this document.

### D1: Upload session is the atomic model boundary
A staged upload session creates exactly one Model. Standard archive upload keeps the original one-archive/one-model behavior. An explicitly selected multipart session may contain several independent complete archives (`combine`) or all parts of one supported split ZIP or modern split RAR set (`split`), but it still produces one review session and one Model. Alexandria never auto-splits archive contents into multiple models. Making grouping explicit avoids accidentally merging files merely because a user selected several archives in the ordinary upload picker.

### D2: Managed storage only
After import/upload, all files live in Alexandria-managed local or S3-compatible storage. Database records retain backend-independent logical keys rather than filesystem paths or public object URLs. No runtime references to import source locations remain. Import strategies determine how files enter managed storage, but once imported, StorageService is the sole authority. The bounded local thumbnail cache used in S3 mode is an implementation detail inside that boundary: it contains only rebuildable copies, while S3 remains authoritative, and it is excluded from migration and rollback source enumeration.

### D3: Metadata unification with specialized storage
All model attributes are metadata conceptually and in the API. Tags and potentially other high-query fields have dedicated backing tables for performance. MetadataService abstracts this — consumers see a uniform metadata API. This prevents the proliferation of per-attribute-type entities and APIs.

### D4: PresenterService as response assembly layer
Route handlers do not assemble response payloads. PresenterService owns the translation from domain data to API response shapes. This prevents response assembly logic from scattering across route files.

### D5: Search abstraction
SearchService wraps the search implementation behind an interface. MVP uses Postgres full-text search. The interface exists from day one so a future swap to MeiliSearch or Typesense requires only a new implementation, not a refactor.

### D6: Cursor-based pagination
All paginated endpoints use cursor-based pagination with total counts. No offset pagination. Cursor is opaque to clients.

### D7: SHA-256 hash on every file
Every ModelFile record includes a SHA-256 hash computed at import/upload time. This enables future deduplication detection and is used for verified deletion in S3 upload flows.

### D8: Collections are not metadata
Collections are organizational structures (where you put a model), not descriptive attributes (what a model is). This is why collections remain a dedicated entity while Artist and Tags are metadata fields.

### D9: Server-side file tree assembly
The file tree for a model's files is assembled by PresenterService from flat relative paths into a nested tree structure. The frontend receives a ready-to-render tree.

### D10: Import strategies for folder import
Folder import supports three local strategies (hardlink, copy, move) and a backend-selected remote path (S3 upload with verified delete). Hardlink is validated for same-filesystem constraint. Move is flagged as destructive. Remote uploads are verified by byte size and SHA-256, and source deletion is a separate pass after the complete job succeeds. Local strategy selection is per import; storage backend selection is process-wide.

### D11: Envelope on every response
All API responses use `{ data, meta, errors }`. No raw arrays, no inconsistent shapes. This is non-negotiable for API consistency.

### D12: Services never format HTTP responses
Services throw typed errors or return domain data. Routes and middleware handle HTTP status codes and envelope formatting. Services have no knowledge of HTTP.

### D13: libraryId is server-injected — never client-supplied
The `requireLibrary` preHandler derives `libraryId` from the authenticated session and writes it to `request.libraryId`. No route accepts a `libraryId` value from the client. This ensures a user cannot access another user's library by supplying an arbitrary `libraryId` in the query string or request body.

### D14: Pivot axis is URL state, not query state
The active pivot axis is stored in the URL so it survives navigation and is shareable, but it is excluded from the React Query key. Fixed axes use `?axis=collections|artists|tags|smart`; browsable metadata fields use `?axis=metadata:<slug>`. Artist and Tags remain reserved dedicated axes and are not duplicated as `metadata:artist` or `metadata:tags`. The axis by itself controls how the rail and context header look. Filter values derived from an axis selection (for example, `collectionId` or `meta_artist`) enter the model query key and trigger refetches; a selected smart collection instead supplies its own query and key.

### D15: three.js is isolated in a single lazy-loaded module
`ModelViewer3DScene` is the only file in the frontend that imports `three`, `@react-three/fiber`, or `@react-three/drei`. All other code reaches it through `ModelViewer3DModal` via `React.lazy`, which causes Vite to emit three.js as a separate async chunk (~924 KB). The chunk is never fetched unless the 3D viewer is opened. This isolation is intentional: adding any static import of three anywhere else in the app would pull the entire bundle into the critical path. If the viewer grows to need additional three.js utilities, they must be added inside `ModelViewer3DScene` or co-located lazy modules — not imported at the app or component level.

### D16: Staged ingestion — scan before commit
Archive uploads no longer create a model immediately. Instead they create an `ImportSession`, extract the archive, and expose detected metadata for review before the user commits. This gives users a chance to verify and supplement auto-detected artist, tags, and collection assignment before the model record is created. Folder imports retain the existing immediate behavior because they operate on server-side directories where the user has already organized the content.

The consequence is that `POST /models/upload` (and the chunked `complete` endpoint) return `{ sessionId }` rather than `{ modelId, jobId }`. Callers that previously polled `GET /models/:id/status` now poll `GET /models/import-sessions/:id`, then call `POST /models/import-sessions/:id/commit` to get `{ modelId, jobId }`. They continue polling the import session for structured commit progress; model status remains the coarse processing/ready/error view.

### D18: Smart collection results are derived, never materialized
A smart collection stores only its rule tree (a `RuleNode` JSONB value). The result set is computed on every read by compiling the tree into SQL and running it through `SearchService.searchModels`. This avoids a membership sync problem — a manual collection would need its membership table updated whenever a model is edited — at the cost of per-request query execution. For the expected library sizes (thousands, not millions of models), this is acceptable. Materialized membership can be added later if performance requires it.

### D19: Rule engine is the single source of truth for per-dimension SQL
`buildLeafCondition` in `rule-engine.ts` is the canonical implementation of "what SQL a filter on dimension X looks like." `searchModels` was refactored to call it for its own flat filter parameters, so flat search and smart-collection compilation are guaranteed to produce identical SQL for equivalent criteria. Any change to how a dimension (e.g., tag membership, metadata value match) is queried must be made in `buildLeafCondition`, not in scattered helpers.

### D17: Cross-entity global search is in-memory for non-model types
`SearchService.searchAll` runs Postgres full-text search for models, but for collections, artists, and tags it fetches the full library-scoped list and filters in memory. This is acceptable because these lists are small (hundreds at most), require no dedicated index, and avoids schema complexity. If list sizes grow to a point where in-memory filtering is measurably slow, the internal implementation can be replaced with index-backed queries without changing the API or callers. Smart collections (P4) may warrant a dedicated index at that point.

### D20: AI mutations require a server-owned preview proposal
The AI provider never receives a direct mutation tool. It can call `preview_changes` for individualized changes or `preview_bulk_changes` for uniform metadata and collection operations. Both validate and store the exact action list in `ai_change_proposals` and return it to the user without changing domain data. The bulk tool accepts `current_models` or `active_library`, not model IDs supplied by the provider. The server resolves that symbolic scope, verifies ownership and library scope, and stores sorted unique model IDs in canonical `bulk_metadata` and/or `bulk_collections` changes. That immutable snapshot is the reviewed and later applied target set. A bulk preview fails when the scope is empty or resolves to more than 500 models; it never truncates the scope or partially applies a larger library. This path is for uniform operations only—individualized enrichment and background AI batch jobs are outside this decision.

Applying changes is a separate authenticated request naming the proposal ID; the server loads the stored payload rather than accepting a replacement payload from the client, revalidates scope and references, rejects expired or already-used proposals, and atomically claims a pending proposal before delegating to domain services. Bulk metadata supports `set`, `add`, and `remove`; `add` is valid only for Tags. Bulk collections support `add` and `remove`. Applying an `update_import_session` proposal changes only the staged metadata draft, and applying `organize_import_session_files` changes only the separately persisted staged file-layout draft. Neither commits, enqueues, or physically reorganizes the upload at apply time; the reviewed layout is expanded and used only during an explicit later import commit. This makes preview-before-apply an API invariant rather than a UI convention, including for bulk edits and pre-queue uploads.

Proposals expire after 15 minutes and are single-use after a successful apply. Apply-time expiry comparisons use PostgreSQL `now()` so application-server clock skew cannot extend the review window. The transaction locks all referenced model and ready-for-review import-session rows in deterministic ID order and revalidates the complete stored change set before the conditional `pending` → `applying` claim. That claim, every individual or bulk model/metadata/collection/draft mutation, and the final `applied` transition run in the same transaction. A downstream failure or process crash rolls back both the domain changes and the claim, leaving the still-unexpired proposal `pending` and safely retryable; no committed `applying` state can be stranded. Collection membership additions/removals and metadata set/add/remove effects are idempotent, while the proposal claim prevents a successfully applied preview from being replayed.

### D21: Hosted PostgreSQL uses the existing persistent database boundary

Hosted PostgreSQL is a deployment choice, not a new service boundary. The same Drizzle schema, startup migrations, timeouts, and process-wide `node-postgres` pool apply to local and hosted databases. TLS settings remain in `DATABASE_URL` so provider-specific certificate and connection requirements are preserved. Because the backend is a persistent process that migrates on startup and holds pooled sessions, direct connections or session-mode poolers are supported; transaction-mode poolers are not the deployment model. Database hosting is independent of managed blob storage, which must use S3-compatible storage when files need to be reachable beyond one host.
