# Alexandria — Architecture Reference

This document is the source of truth for Alexandria's architecture. Every structural decision, service boundary, and type relationship is defined here. Implementation agents must consult this document before making any structural decisions. If something isn't covered here, that's a signal to propose an architecture update — not to improvise.

---

## System Overview

Alexandria is a self-hosted personal library for 3D printing model collections. It manages the upload, processing, organization, browsing, and search of 3D printing model files. The primary deployment target is Docker Compose.

The system follows a monorepo structure with a React frontend, a Fastify backend, and a shared types package. The backend is organized around focused services with clear ownership boundaries. All file processing happens asynchronously via a job queue.

### Core Principles

- **Archive-as-entity**: An uploaded archive (zip, rar, 7z, tar.gz) defines one model. All contents belong to that single entry. No splitting.
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

Every model and collection belongs to a library. Libraries are the top-level organizational scope introduced in P1 as a foundation for future multi-library support.

### Schema

The `libraries` table (`apps/backend/src/db/schema/library.ts`) has these columns: `id` (UUID PK), `name`, `slug` (globally unique), `user_id` (FK → users), `is_default` (boolean), `created_at`, `updated_at`.

Both `models` and `collections` carry a `library_id` column (NOT NULL FK → libraries). This was added by migration `0007_add_library_id` after `0005_add_libraries` created the table and `0006_backfill_default_libraries` ensured every existing user had exactly one default library to backfill into.

One-default-per-user is enforced at the database level with a partial unique index:

```sql
CREATE UNIQUE INDEX libraries_user_default_unique ON libraries (user_id) WHERE is_default
```

This index makes the enforcement race-safe: the database rejects a second `is_default = true` row for the same user even under concurrent writes.

### LibraryService

`LibraryService.resolveDefaultLibraryId(userId)` is the single entry point for resolving a user's active library. It finds the user's `is_default = true` library and returns its id. If none exists (users created after the migration backfill), it creates one with name `"Library"`. This lazy creation mirrors what the migration backfill did for pre-existing users.

The seed (`runSeed`) calls this method for the admin user on startup, so the admin always has a default library even on a fresh database.

### The `requireLibrary` Prehandler

`requireLibrary` (`apps/backend/src/middleware/library.ts`) is a Fastify preHandler that runs after `requireAuth` on every route that reads or writes library-scoped data. It calls `LibraryService.resolveDefaultLibraryId` and stores the result on `request.libraryId`.

**Security invariant:** `libraryId` is server-injected only. No route accepts a `libraryId` from the client in the query string, path, or request body. The value is always derived from the authenticated session. This prevents one user from accessing another user's library by supplying a different `libraryId`.

Routes that apply `requireLibrary` (as of P3):

- `GET /models`
- `GET /collections`, `POST /collections`
- `GET /collections/:id/models`
- `GET /metadata/fields/:slug/values`
- `POST /models/upload`, `POST /models/upload/:uploadId/complete`, `POST /models/import`
- `GET /models/import-sessions`, `POST /models/import-sessions/:id/commit`
- `GET /search`

By-id detail routes (`GET /models/:id`, `GET /collections/:id`, `PATCH /models/:id`, etc.) remain owned by `userId` and are not yet library-scoped. Library scoping for detail routes is deferred to P5 multi-library.

### P4 Deferrals

The following are deferred to the Smart Collections phase:

- Smart (rule-based) collections entity and rule engine. `SearchService.searchAll` returns only manual collections. When smart collections ship, `searchAll` will need to union both types.

### P5 Deferrals

The following are explicitly deferred to the multi-library phase:

- Multi-library UI and routing (the library-switcher button in PivotRail is a non-interactive stub).
- Library scoping for by-id detail routes (`GET /models/:id`, `GET /collections/:id`, etc.).
- Per-collection group counts in group view (requires server support to return paginated per-group totals).

---

## Service Inventory

### LibraryService

**Owns:** Resolving and lazily creating a user's default library.

**Does not own:** Library CRUD, multi-library switching (deferred to P5), or any data scoped within a library.

**Behavior:** `resolveDefaultLibraryId(userId)` finds the user's default library in the `libraries` table. If none exists, it inserts one (name: `"Library"`, `is_default: true`) and returns its id. The partial unique index on the table makes this safe under concurrent calls.

### IngestionService

**Owns:** Upload and import orchestration, pipeline sequencing, Model record creation in "processing" state, staged scan/commit coordination.

**Does not own:** File I/O, thumbnail generation, extraction logic, storage.

**Behavior:** Receives upload or import requests and coordinates the full pipeline. The job worker calls back into IngestionService's pipeline methods, which coordinate FileProcessingService, ThumbnailService, StorageService, and MetadataService in sequence. On completion, updates model status to `ready` or `error`.

Three entry paths:

- **Staged upload (scan phase):** `handleScan` receives a temp file path, creates an `ImportSession` (via ImportSessionService), and enqueues a scan job on the `import-scan` BullMQ queue. The worker's `processScanJob` extracts the archive, detects metadata heuristically, and updates the session to `ready_for_review`. No model is created at this stage.

- **Staged upload (commit phase):** `handleCommit` validates the session is `ready_for_review`, creates a Model record in `processing` state, transitions the session to `committing`, and enqueues a commit job on the `import-commit` BullMQ queue. The worker's `processCommitJob` copies staged files to managed storage, runs the thumbnail pipeline, and applies any `BatchUploadMetadata` supplied at commit time.

- **Folder import:** `handleFolderImport` receives an `ImportConfig` (source path, pattern, strategy). Uses PatternParser to validate and parse the hierarchy pattern, FileProcessingService to walk the directory, and the selected ImportStrategy to move files into managed storage. Folder import retains its existing immediate behavior — it does not use the staged session model.

### ImportSessionService

**Owns:** `import_sessions` table CRUD — creating sessions, updating their status and detected metadata, listing active sessions, ownership validation.

**Does not own:** File extraction (FileProcessingService), ingestion pipeline (IngestionService), storage cleanup.

**Behavior:** `create` inserts a session in `scanning` status with a 24-hour `expiresAt`. `update` patches status and any combination of `detected`, `manifest`, `stagingPath`, `modelId`, and `error`. `listActive` returns sessions in `scanning`, `ready_for_review`, `committing`, or `error` status for a given user and library. `getOwnedRow` fetches a session and throws `NOT_FOUND` if it doesn't exist or belongs to a different user. `toDto` maps the DB row to the `ImportSession` API shape (omitting `manifest` and `stagingPath`).

### FileProcessingService

**Owns:** Zip extraction, folder directory walking, file type classification, basic metadata extraction from file contents and names.

**Does not own:** File storage, thumbnail generation, database record persistence.

**Behavior:** Given an archive file (zip, rar, 7z, tar.gz) or directory path, produces a structured manifest describing what was found: files with their relative paths, classified types, sizes, and any metadata extractable from filenames or structure. This manifest is what IngestionService uses to create ModelFile records and route files to storage.

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

- `searchModels(params, libraryId)` — accepts query parameters (text search, metadata filters, collection filter, sort, pagination cursor). Executes against Postgres full-text search. Understands which metadata fields use optimized storage (tags → join table query) vs. generic storage (other fields → model_metadata table query). Returns paginated results as `ModelCard` objects assembled by PresenterService.

- `searchAll(params, userId, libraryId)` — cross-entity search. Calls `searchModels` for models (full-text), then filters in-memory against collections (by name substring, sorted by `modelCount`), artist values, and tag values (both by name substring, drawn from `listFieldValues`). Results for each entity type are limited to `params.limit` (default 6). Returns a `GlobalSearchResult`.

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

### AuthService

**Owns:** User CRUD, password hashing, authentication, session creation and validation.

**Does not own:** Authorization or permissions (future scope).

**MVP scope:** Single-user local auth with email and password. Session-based. The User schema reserves columns for future OIDC/OAuth integration but the wiring is not built in MVP.

### UploadService

**Owns:** Chunked upload session management. Tracks in-flight upload sessions in memory, stores individual chunks to a temporary directory, and assembles them into a single file for handoff to IngestionService.

**Does not own:** Ingestion pipeline, storage, database.

**Behavior:** `initUpload` creates a session with a UUID, a temporary chunks directory, and a 2-hour expiry. `receiveChunk` writes each binary chunk to disk by index, enabling per-chunk retry (re-uploading a chunk index overwrites the previous write). `assembleFile` concatenates all chunks in order, verifies the assembled size matches the declared `totalSize`, cleans up the temporary directory, and returns the path for IngestionService to consume. Expired sessions are purged on a 10-minute interval.

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
| PUT | /models/upload/:uploadId/chunk/:index | Upload a single chunk | UploadService | No |
| POST | /models/upload/:uploadId/complete | Assemble chunks → scan (returns sessionId) | UploadService → IngestionService → JobService | Yes |
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

### D1: Archive-as-atomic-entity
An archive upload (zip, rar, 7z, tar.gz) creates exactly one Model. No splitting, no multi-model extraction. The archive boundary is the model boundary.

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

### D17: Cross-entity global search is in-memory for non-model types
`SearchService.searchAll` runs Postgres full-text search for models, but for collections, artists, and tags it fetches the full library-scoped list and filters in memory. This is acceptable because these lists are small (hundreds at most), require no dedicated index, and avoids schema complexity. If list sizes grow to a point where in-memory filtering is measurably slow, the internal implementation can be replaced with index-backed queries without changing the API or callers. Smart collections (P4) may warrant a dedicated index at that point.
