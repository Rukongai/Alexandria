# Alexandria — Architecture Reference

This document is the source of truth for Alexandria's architecture. Every structural decision, service boundary, and type relationship is defined here. Implementation agents must consult this document before making any structural decisions. If something isn't covered here, that's a signal to propose an architecture update — not to improvise.

---

## System Overview

Alexandria is a self-hosted personal library for 3D printing model collections. It manages the upload, processing, organization, browsing, and search of 3D printing model files. The primary deployment target is Docker Compose.

The system follows a monorepo structure with a React frontend, a Fastify backend, and a shared types package. The backend is organized around focused services with clear ownership boundaries. All file processing happens asynchronously via a job queue.

### Core Principles

- **Upload-session-as-entity**: A staged upload session defines one model. A standard session contains one archive; an explicitly grouped session may combine several independent archives or all parts of one supported split archive. All extracted contents still belong to one model, and Alexandria never infers multiple models from archive contents.
- **Structure preservation**: Internal folder hierarchy within archives is first-class data. Relative paths are preserved and navigable.
- **Managed storage**: After import/upload, Alexandria owns all files in its managed storage root. External file references do not exist at runtime.
- **Metadata unification**: All model attributes (tags, artist, year, custom fields) are conceptually metadata. Some fields have optimized backing storage for query performance. The API treats them uniformly.
- **Server-side assembly**: The backend does the heavy lifting of data shaping. PresenterService assembles view-ready payloads. The frontend receives clean, ready-to-render data.

---

## Startup Sequence

When the backend process starts (`server.ts`), it runs three steps before accepting traffic:

1. **Migrations** — Drizzle applies any pending SQL migrations from `apps/backend/src/db/migrations/`. If migration fails, the process exits with a non-zero code.
2. **Seed** — `runSeed()` inserts the default admin user and default metadata field definitions using `ON CONFLICT DO NOTHING`, then calls `LibraryService.resolveDefaultLibraryId` for the admin user to ensure the admin's default library exists. This is idempotent and safe to run on every startup. If the seed fails (e.g., a constraint violation on a partially seeded DB), it logs a warning and continues rather than crashing. Seed credentials are controlled by `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, and `SEED_ADMIN_DISPLAY_NAME` environment variables.
3. **Listen** — Fastify binds to the configured `HOST:PORT` and begins accepting requests.

In Docker Compose, the `backend` service declares `depends_on` with `condition: service_healthy` for both Postgres and Redis, so both infrastructure services are ready before the backend starts.

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
│  └─────────┘  └──────────────┘  │ MetadataService     │   │
│                                  │ CollectionService   │   │
│  requireAuth ──→ requireLibrary  │ SearchService       │   │
│  (injects request.libraryId)     │ AuthService         │   │
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
          │   PostgreSQL + Redis     │
          └─────────────────────────┘
```

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

**Security invariant:** `libraryId` is never trusted from untrusted input. The header is accepted only after `resolveLibraryId` confirms the user owns that library; an unknown or un-owned id returns `NOT_FOUND` (same error either way, so ids cannot be enumerated). No route accepts a `libraryId` in the query string, path, or body. The frontend mirrors its `/lib/:id` route segment into the header; the `/libraries` management routes do **not** use `requireLibrary` (they manage the scope itself, keyed by URL `:id` + `userId`).

Routes that apply `requireLibrary` (as of P5):

- `GET /models`, `GET /models/:id`, `GET /models/:id/files`, `GET /models/:id/status`
- `GET /collections`, `POST /collections`, `GET /collections/:id`, `GET /collections/:id/models`
- `GET /metadata/fields/:slug/values`
- `POST /models/upload`, `POST /models/upload/:uploadId/complete`, `POST /models/upload/multipart/complete`, `POST /models/import`
- `GET /models/import-sessions`, `POST /models/import-sessions/:id/commit`
- `GET /search`
- All `/smart-collections` routes
- `POST /ai/chat`, `POST /ai/proposals/:id/apply`

P5 added library-scope guards to the read/detail routes above via `ModelService.requireModelInLibrary` / `CollectionService.requireCollectionInLibrary` (the entity must belong to `request.libraryId`, else `NOT_FOUND`), so a stale deep link to another library's item 404s after switching. By-id **mutation** routes (`PATCH`/`DELETE /models/:id`, `PATCH`/`DELETE /collections/:id`) remain `userId`-owned only — they are same-user operations and were intentionally left out of the minimal P5 sweep.

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

## Service Inventory

### LibraryService

**Owns:** Resolving a user's active library (default or `X-Library-Id`-requested, ownership-checked) and full library management CRUD (list-with-counts, create, rename/recolor, set-default, delete).

**Does not own:** Any data scoped *within* a library (models, collections, etc.), or multi-user sharing (P6).

**Behavior:** `resolveDefaultLibraryId(userId)` finds (or lazily creates) the user's default library; `resolveLibraryId(userId, requestedId?)` validates a requested library against ownership before use. Management methods are detailed under *Data Model: Library Scope → LibraryService*. The partial unique index on `(user_id) WHERE is_default` keeps default resolution and `setDefaultLibrary` race-safe.

### IngestionService

**Owns:** Upload and import orchestration, pipeline sequencing, Model record creation in "processing" state, staged scan/commit coordination.

**Does not own:** File I/O, thumbnail generation, extraction logic, storage.

**Behavior:** Receives upload or import requests and coordinates the full pipeline. The job worker calls back into IngestionService's pipeline methods, which coordinate FileProcessingService, ThumbnailService, StorageService, and MetadataService in sequence. On completion, updates model status to `ready` or `error`.

Three entry paths:

- **Staged upload (scan phase):** `handleScan` receives one archive, creates an `ImportSession` (via ImportSessionService), and enqueues a scan job on the `import-scan` BullMQ queue. `handleMultipartScan` does the same for an explicit archive group, carrying either `combine` (independent complete archives extracted under collision-safe archive-name folders) or `split` (one recognized split ZIP or modern split RAR set, colocated and extracted as a unit) through the scan job. Split sessions use a selection-order-independent logical filename: the classic terminal `.zip`, the numbered set's base `.zip`, or `<base>.rar` derived from RAR part 1. The worker's `processScanJob` extracts the input, detects metadata heuristically, forces multipart `detected.modelCount` to `1`, and updates the session to `ready_for_review`. No model is created at this stage.

- **Staged upload (commit phase):** `handleCommit` validates the session is `ready_for_review`, creates a Model record in `processing` state, transitions the session to `committing`, and enqueues a commit job on the `import-commit` BullMQ queue. The worker's `processCommitJob` copies staged files to managed storage, runs the thumbnail pipeline, and applies any `BatchUploadMetadata` supplied at commit time.

- **Folder import:** `handleFolderImport` receives an `ImportConfig` (source path, pattern, strategy). Uses PatternParser to validate and parse the hierarchy pattern, FileProcessingService to walk the directory, and the selected ImportStrategy to move files into managed storage. Folder import retains its existing immediate behavior — it does not use the staged session model.

### ImportSessionService

**Owns:** `import_sessions` table CRUD — creating sessions, updating their status and detected metadata, listing active sessions, ownership validation.

**Does not own:** File extraction (FileProcessingService), ingestion pipeline (IngestionService), storage cleanup.

**Behavior:** `create` inserts a session in `scanning` status with a 24-hour `expiresAt`. `update` patches status and any combination of `detected`, `manifest`, `stagingPath`, `modelId`, and `error`. `listActive` returns sessions in `scanning`, `ready_for_review`, `committing`, or `error` status for a given user and library. `getOwnedRow` fetches a session and throws `NOT_FOUND` if it doesn't exist or belongs to a different user. `toDto` maps the DB row to the `ImportSession` API shape (omitting `manifest` and `stagingPath`).

### FileProcessingService

**Owns:** Zip extraction, folder directory walking, file type classification, basic metadata extraction from file contents and names.

**Does not own:** File storage, thumbnail generation, database record persistence.

**Behavior:** Given an archive file (zip, rar, 7z, tar.gz, tgz), an explicit multipart archive group, or a directory path, produces a structured manifest describing what was found: files with their relative paths, classified types, sizes, and any metadata extractable from filenames or structure. In `combine` mode every source must be an independent complete archive with a plain filename. Each archive is extracted beneath a folder derived from that filename, empty or dot-only folder names are rejected, folder collisions are resolved case-insensitively with `-2`, `-3`, and later suffixes, and the resolved folder must remain a strict descendant of the extraction root. In `split` mode the service validates either a contiguous classic `.z01` … `.z99` set plus one terminal `.zip`, a contiguous numbered `.zip.001` … `.zip.999` set, or a modern contiguous `<base>.partN.rar` set starting at part 1. Every set must use one case-insensitive base name; RAR members additionally require a safe base and consistent part-number padding. The service copies normalized member names into a temporary colocation directory, invokes 7-Zip on the ZIP entry member, or invokes the RAR handler on part 1 so the remaining volumes can be resolved beside it, then removes the temporary directory. Before 7-Zip-based extraction it requests technical metadata and rejects absolute, drive-qualified, UNC, or parent-traversal paths plus symbolic links, hard links, and reparse entries. Link detection covers dedicated fields and Unix link modes or reparse markers reported through `Mode` or `Attributes`; extraction-reported paths outside the destination are also rejected. This manifest is what IngestionService uses to create ModelFile records and route files to storage.

Uses the **PatternParser** utility (located in `utils/pattern-parser.ts`) — a pure function that takes a user-defined hierarchy pattern string (e.g., `{Collection}/{metadata.Artist}/{model}`), validates it, and returns a structured representation. Validation rules: pattern must end with `{model}`, segments must be `{Collection}` or `{metadata.<fieldSlug>}`, and `{model}` cannot appear in the middle.

### StorageService

**Owns:** Blob storage and retrieval, path management within the managed storage root, deletion.

**Does not own:** Any knowledge of domain entities. It stores and retrieves bytes at paths.

**Interface:** Designed for swappable implementations. The local filesystem implementation is the default. An S3-compatible implementation is planned for Phase 2. All other services interact with StorageService through the interface — never directly with the filesystem or S3 SDK.

**Import strategies** are implementations of an ImportStrategy interface used during folder import:
- `HardlinkStrategy` — validates same-filesystem requirement, creates hardlinks into managed storage. Falls back to copy with a warning if hardlinking fails.
- `CopyStrategy` — copies files into managed storage. Safe default.
- `MoveStrategy` — moves files into managed storage. Destructive to originals.
- `S3UploadStrategy` (Phase 2) — uploads to S3 with SHA-256 verification. Optional verified deletion of originals after all uploads succeed. Deletion is a separate pass, never inline with uploads.

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

### ModelService

**Owns:** Model and ModelFile CRUD. Creating, reading, updating, deleting Model records. Managing ModelFile records and their relationships to models.

**Does not own:** Metadata (delegates to MetadataService), ingestion pipeline, search, storage, thumbnail generation.

### MetadataService

**Owns:** Metadata field definitions, metadata values on models, optimized storage routing for performance-critical field types.

**Does not own:** Model entity itself, search execution, presentation.

**Key architectural decision — uniform interface, specialized storage:** All metadata is accessed through MetadataService's API uniformly. Internally, MetadataService routes certain field types to optimized backing storage:
- **Tags** (type `multi_enum` with `isDefault: true`): stored in dedicated `tags` and `model_tags` tables for join performance.
- **All other fields**: stored in the generic `model_metadata` table.

No other service knows about this routing. To every consumer, tags are just another metadata field. If a future field type (e.g., Artist) needs optimized storage, MetadataService adds the optimization internally without API changes.

**Default fields** seeded on startup: Artist (text), Year (number), NSFW (boolean), URL (url), Pre-supported (boolean). These have `isDefault: true` and cannot be deleted.

### CollectionService

**Owns:** Collection CRUD, parent-child nesting (tree operations), collection-model membership (add/remove models from collections).

**Does not own:** Model data, search, metadata.

**Boundary note:** CollectionService owns "add/remove model from collection." ModelService can read "what collections is this model in" for display purposes but does not mutate collection membership.

Collections are an organizational structure, not metadata. A model's relationship to a collection is about where you put it, not what it is. This is why collections remain a separate entity while Artist and Tags moved into the metadata system.

### SmartCollectionService

**Owns:** Smart collection CRUD, rule-tree validation, derived model result sets, unsaved rule-tree preview (dry-run).

**Does not own:** Rule compilation to SQL (delegates to `compileRuleTree` in `rule-engine.ts`), model querying (delegates to `SearchService.searchModels`).

**Behavior:** `create` and `update` call `resolveAndCompile` before any DB write, so a syntactically valid but semantically invalid tree (unknown metadata slug, illegal operator for a field's type) is rejected with a `VALIDATION_ERROR` rather than persisted. `getById` and `getModels` call `requireOwnedSmartCollection` first, which enforces ownership + library in a single query and returns `NOT_FOUND` on any mismatch. The list endpoint omits derived model counts to keep it cheap; `getById` and `create`/`update` compute a live count via `searchModels`.

`resolveAndCompile` resolves all metadata leaf conditions against live field definitions, validates operator/type compatibility using `LEGAL_OPERATORS_BY_METADATA_TYPE`, and decides whether to suppress `searchModels`' implicit `status = 'ready'` default (see `applyDefaultStatus` seam above).

### AI Assistant Services

The authenticated workspace mounts an assistant bubble in `AppShell`. The assistant is library-scoped and may inspect/search models, look up public web and image candidates, and prepare model, metadata/tag, cover, and collection changes. It is split into focused services:

- **AiProviderService** owns user-scoped OpenAI-compatible provider configuration, encrypted API-key storage, default-provider selection, model discovery, and connection tests. Default-changing create, update, and delete transactions take a per-user PostgreSQL advisory lock, while the partial unique index remains the database backstop; concurrent requests cannot leave ambiguous defaults. Provider secrets are decrypted only for outbound provider requests and are never returned by the API; provider responses expose only `hasApiKey` and a short hint. Base URLs cannot contain embedded credentials and are DNS-resolved and checked against the provider-network policy when saved and before every request. Before each redirect hop, every resolved address is classified and the complete deduplicated vetted set is pinned into a short-lived Undici dispatcher. Undici may fail over among only those addresses without another DNS lookup; the request URL remains unchanged so HTTP Host and TLS SNI still identify the configured hostname, and the dispatcher is closed after the response is consumed or cancelled. Public endpoints require HTTPS; HTTP is accepted only when every resolved address is private/loopback and private providers are enabled. DNS resolution is capped at 3 seconds. Provider responses are capped at 2 MiB. Redirects are handled manually, revalidated, restricted to the original origin, and capped at three under one 10-second request deadline. Upstream failure bodies are not reflected into Alexandria API errors.
- **AiAssistantService** owns the bounded OpenAI-compatible tool loop. Read-only tools search the active library, inspect an owned model, and query web/image search adapters. Its only write-shaped tool is `preview_changes`, which validates and persists an immutable proposal but performs no domain mutation. Per-call, cumulative tool, provider-context, and assistant-response budgets bound resource use. Each user is limited to 10 chat starts per minute and two concurrent chats. This limiter is deliberately process-local for the single-instance deployment, holds at most 10,000 user entries, and resets on restart; a shared limiter is required before running multiple backend replicas. Client disconnect cancellation is propagated through the assistant into provider and public-search fetches and combined with their existing deadlines. Provider resolution, context assembly, library/model tools, and proposal creation are also raced against cancellation and the remaining request deadline. The shared PostgreSQL pool has a 5-second connection-acquisition timeout, 45-second server statement timeout, and 50-second client query timeout, bounding underlying database work that cannot be actively cancelled by the race. Expected tool errors are bounded before being returned to the provider, while unexpected internal/tool errors are replaced with a generic message.
- **AiProposalService** owns proposal validation and application. It re-checks user and library ownership, expiry, pending status, referenced metadata fields, image files, and collections at both preview and apply time. Preview validation and persistence share a transaction with operation-deadline statement limits and cancellation checks around the insert, preventing an abandoned chat from committing a late proposal. Apply deterministically locks all referenced model rows `FOR UPDATE`, fully revalidates through that same transaction executor, then conditionally claims and delegates approved actions to ModelService, MetadataService, and CollectionService. Preview responses include server-resolved collection names and image filenames/thumbnail URLs so the human review UI does not have to present opaque UUIDs.
- **WebSearchService** owns outbound public lookup and normalizes results into source cards. Text lookup uses the DuckDuckGo Instant Answer API; image lookup uses Wikimedia Commons. These are public, keyless services rather than configurable search providers. Requests time out after 7 seconds and response bodies are capped at 1 MiB. A failed lookup is returned to the assistant as an unavailable tool result so the rest of the conversation can continue. It never imports a remote image into managed storage or mutates library data: a public image URL is a research candidate only, while a cover-image proposal must reference an image file that already belongs to the model. The frontend may load a returned Wikimedia thumbnail when it renders the source card.

Provider configuration is user-scoped, while proposals are scoped to both user and active library. Chat transcripts are client-session state and are not persisted in this version. Messages, supplied history, model context, and tool results needed for a turn are sent to the selected external provider, so operators must treat provider selection as a data-disclosure boundary.

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

**Behavior:** Provides a clean interface for enqueuing jobs, querying job status, and managing retries. IngestionService uses it to enqueue processing jobs. The worker processes invoke IngestionService pipeline methods.

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
│              │  UploadPage, SettingsPage                 │
└──────────────┴──────────────────────────────────────────┘
```

`PivotRail` is permanently mounted for all authenticated routes. The old `Sidebar.tsx` and global `Header.tsx` components were deleted; their responsibilities moved into the rail and PivotMain's top bar respectively.

### PivotRail

The rail contains, top to bottom:

1. **Library header** — brand mark plus a library-name badge. The badge includes a chevron-down but is non-interactive (`aria-disabled`, `tabIndex=-1`): multi-library switching is a P5 stub.
2. **AxisPicker** — a 2-column button grid for selecting the active axis (Collections, Artists, Tags).
3. **AxisFacetBody** — a scrollable list for the active axis. Shows collections tree, artist values, or tag values, each pulling from the appropriate backend endpoint.
4. **UserMenu** — pinned footer with user avatar, display name, theme toggle, Settings link, and Log out.

### Axes

The "axis" is the currently-selected browse dimension. It is stored in the URL as `?axis=` (e.g., `?axis=artists`). The default axis is `collections`, which is omitted from the URL for clean links.

The axis is **pure UI state**. It is kept out of the React Query key and does not affect the API request made by `useModelResults`. Changing the axis reshapes the rail and the context header but does not refetch models unless the axis selection also changes the active filter (e.g., selecting a collection updates `?collectionId=`).

The three axes and what they do in the rail:

| Axis | Rail body | Active filter set |
|------|-----------|-------------------|
| `collections` | Collections tree | `collectionId` query param |
| `artists` | Artist values + model counts | `meta_artist` query param |
| `tags` | Tag values + model counts | `tags` query param |

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

**Group view limitation:** For `axis=collections`, per-collection grouping requires collection membership on `ModelCard`, which the API does not currently return. Group view renders a single group for the collections axis. For `artists` and `tags`, grouping runs client-side on loaded models; group counts reflect loaded models only and will grow as infinite scroll loads more pages.

### Navigation

Routes unchanged from P0: `/models/:id`, `/collections`, `/collections/:id`, `/upload`, `/settings`. The standalone `/collections` nav link was removed from the left rail (collections are now an axis, not a separate page), but the route itself still exists for direct navigation and is used by collection-detail links.

`/lib/:id` (multi-library routing) does not exist yet; deferred to P5.

---

## Frontend: Upload Page

`UploadPage` exposes three upload methods as tabs: **Archive upload**, **Multi-part archive**, and **Server folder import**. Ordinary multi-select in Archive upload preserves the one-archive/one-session behavior. The Multi-part archive tab is the explicit grouping boundary and creates one review session from 2–100 selected files.

`MultipartArchiveUpload` (`components/upload/multipart-archive-upload.tsx`) requires the user to select one of two modes. **Combine archives** accepts independent complete `.zip`, `.rar`, `.7z`, `.tar.gz`, or `.tgz` archives and preserves each archive under a separate archive-named folder. **Split archive** accepts a complete classic `.z01` … `.zip` set, numbered `.zip.001` … set, or modern `<base>.part1.rar` … `<base>.partN.rar` set. Client validation checks count, non-empty files, the 5 GB per-file limit, filename length, supported extensions, one naming scheme and base name, duplicate part numbers, and contiguous numbering from part 1. Modern RAR sets also require consistent part-number padding. The backend repeats the security- and integrity-relevant validation and derives a stable logical filename from the split set rather than selection order. The review queue always describes the result as one model, matching the forced multipart `modelCount`.

The frontend initializes and uploads each file sequentially through the chunked protocol, reports byte-weighted progress across the group, and completes the group with the ordered upload IDs plus its selected mode. If upload or completion fails, it sends best-effort abort requests for every initialized ID and preserves the original error. A successful completion switches back to Archive upload and selects the single new review session in the queue.

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
| GET | /models/:id | Model detail | ModelService → PresenterService | No (userId) |
| GET | /models/:id/files | File tree | ModelService → PresenterService | No (userId) |
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
| POST | /models/import-sessions/:id/commit | Commit session → create model | IngestionService → JobService | Yes |
| DELETE | /models/import-sessions/:id | Discard session + staged files | IngestionService | No (userId) |
| GET | /models/:id/status | Processing status | JobService | No (userId) |
| PATCH | /models/:id | Update model | ModelService → PresenterService | No (userId) |
| DELETE | /models/:id | Delete model + files | ModelService → StorageService | No (userId) |

"Library-scoped" means the route applies the `requireLibrary` preHandler and scopes its read or write to `request.libraryId`. By-id routes are still owned by `userId` and library-scoping for detail routes is deferred to P5.

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
| POST | /ai/chat | Run one library-assistant turn | AiAssistantService → AiProviderService; tool calls may use SearchService, ModelService → PresenterService, WebSearchService, or AiProposalService | Yes | Yes |
| POST | /ai/proposals/:id/apply | Apply an exact stored preview once | AiProposalService → ModelService / MetadataService / CollectionService | Yes | Yes |

All provider routes apply `requireAuth` and enforce provider ownership in `AiProviderService`; they do not apply `requireLibrary` because provider settings belong to a user rather than one library. Chat and proposal application apply `requireAuth` followed by `requireLibrary`. `AiAssistantService` passes the resolved user and library scope through every library/model tool, and `AiProposalService` revalidates both scopes before atomically claiming an apply request.

**Files (Static Serving)**
| Method | Route | Purpose | Service Chain |
|--------|-------|---------|---------------|
| GET | /files/thumbnails/:id.webp | Serve thumbnail | StorageService |
| GET | /files/models/:modelId/* | Serve model file | StorageService |

**Search**
| Method | Route | Purpose | Service Chain | Library-scoped |
|--------|-------|---------|---------------|---------------|
| GET | /search | Cross-entity search (models, collections, artists, tags) | SearchService | Yes |

**Bulk Operations**
| Method | Route | Purpose | Service Chain |
|--------|-------|---------|---------------|
| POST | /bulk/metadata | Metadata changes on multiple models | MetadataService |
| POST | /bulk/collection | Add/remove models from collections | CollectionService |
| POST | /bulk/delete | Delete multiple models | ModelService → StorageService |

---

## Decision Log

Decisions recorded here are intentional and should not be reversed without explicit discussion and an update to this document.

### D1: Upload session is the atomic model boundary
A staged upload session creates exactly one Model. Standard archive upload keeps the original one-archive/one-model behavior. An explicitly selected multipart session may contain several independent complete archives (`combine`) or all parts of one supported split ZIP or modern split RAR set (`split`), but it still produces one review session and one Model. Alexandria never auto-splits archive contents into multiple models. Making grouping explicit avoids accidentally merging files merely because a user selected several archives in the ordinary upload picker.

### D2: Managed storage only
After import/upload, all files live in Alexandria's managed storage. No runtime references to external file locations. Import strategies (hardlink, copy, move) determine how files enter managed storage, but once imported, StorageService is the sole authority.

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
Folder import supports three local strategies (hardlink, copy, move) and one remote strategy (S3 upload with verified delete). Hardlink is validated for same-filesystem constraint. Move is flagged as destructive. S3 delete is a separate pass after all uploads succeed. Strategy selection is per-import, not a global setting.

### D11: Envelope on every response
All API responses use `{ data, meta, errors }`. No raw arrays, no inconsistent shapes. This is non-negotiable for API consistency.

### D12: Services never format HTTP responses
Services throw typed errors or return domain data. Routes and middleware handle HTTP status codes and envelope formatting. Services have no knowledge of HTTP.

### D13: libraryId is server-injected — never client-supplied
The `requireLibrary` preHandler derives `libraryId` from the authenticated session and writes it to `request.libraryId`. No route accepts a `libraryId` value from the client. This ensures a user cannot access another user's library by supplying an arbitrary `libraryId` in the query string or request body.

### D14: Pivot axis is URL state, not query state
The active pivot axis (`?axis=collections|artists|tags`) is stored in the URL so it survives navigation and is shareable, but it is excluded from the React Query key. The axis controls how the rail and context header look; it does not change the underlying API request. Only the filter values derived from an axis selection (e.g., `collectionId`, `meta_artist`) enter the query key and trigger refetches.

### D15: three.js is isolated in a single lazy-loaded module
`ModelViewer3DScene` is the only file in the frontend that imports `three`, `@react-three/fiber`, or `@react-three/drei`. All other code reaches it through `ModelViewer3DModal` via `React.lazy`, which causes Vite to emit three.js as a separate async chunk (~924 KB). The chunk is never fetched unless the 3D viewer is opened. This isolation is intentional: adding any static import of three anywhere else in the app would pull the entire bundle into the critical path. If the viewer grows to need additional three.js utilities, they must be added inside `ModelViewer3DScene` or co-located lazy modules — not imported at the app or component level.

### D16: Staged ingestion — scan before commit
Archive uploads no longer create a model immediately. Instead they create an `ImportSession`, extract the archive, and expose detected metadata for review before the user commits. This gives users a chance to verify and supplement auto-detected artist, tags, and collection assignment before the model record is created. Folder imports retain the existing immediate behavior because they operate on server-side directories where the user has already organized the content.

The consequence is that `POST /models/upload` (and the chunked `complete` endpoint) return `{ sessionId }` rather than `{ modelId, jobId }`. Callers that previously polled `GET /models/:id/status` now poll `GET /models/import-sessions/:id`, then call `POST /models/import-sessions/:id/commit` to get a `{ modelId, jobId }` to track the final ingestion.

### D18: Smart collection results are derived, never materialized
A smart collection stores only its rule tree (a `RuleNode` JSONB value). The result set is computed on every read by compiling the tree into SQL and running it through `SearchService.searchModels`. This avoids a membership sync problem — a manual collection would need its membership table updated whenever a model is edited — at the cost of per-request query execution. For the expected library sizes (thousands, not millions of models), this is acceptable. Materialized membership can be added later if performance requires it.

### D19: Rule engine is the single source of truth for per-dimension SQL
`buildLeafCondition` in `rule-engine.ts` is the canonical implementation of "what SQL a filter on dimension X looks like." `searchModels` was refactored to call it for its own flat filter parameters, so flat search and smart-collection compilation are guaranteed to produce identical SQL for equivalent criteria. Any change to how a dimension (e.g., tag membership, metadata value match) is queried must be made in `buildLeafCondition`, not in scattered helpers.

### D17: Cross-entity global search is in-memory for non-model types
`SearchService.searchAll` runs Postgres full-text search for models, but for collections, artists, and tags it fetches the full library-scoped list and filters in memory. This is acceptable because these lists are small (hundreds at most), require no dedicated index, and avoids schema complexity. If list sizes grow to a point where in-memory filtering is measurably slow, the internal implementation can be replaced with index-backed queries without changing the API or callers. Smart collections (P4) may warrant a dedicated index at that point.

### D20: AI mutations require a server-owned preview proposal
The AI provider never receives a direct mutation tool. It can only call `preview_changes`, which stores the exact validated action list in `ai_change_proposals` and returns it to the user. Applying changes is a separate authenticated request naming that proposal ID; the server loads the stored payload rather than accepting a replacement payload from the client, revalidates scope and references, rejects expired or already-used proposals, and atomically claims a pending proposal before delegating to domain services. This makes preview-before-apply an API invariant rather than a UI convention.

Proposals expire after 15 minutes and are single-use after a successful apply. Apply-time expiry comparisons use PostgreSQL `now()` so application-server clock skew cannot extend the review window. The transaction locks all referenced model rows in deterministic ID order and revalidates the complete stored change set before the conditional `pending` → `applying` claim. That claim, every model/metadata/collection mutation, and the final `applied` transition run in the same transaction. A downstream failure or process crash rolls back both the domain changes and the claim, leaving the still-unexpired proposal `pending` and safely retryable; no committed `applying` state can be stranded.
