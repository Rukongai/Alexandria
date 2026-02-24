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

## Component Map

```
┌─────────────────────────────────────────────────────────┐
│                        Frontend                          │
│              React + Vite + TypeScript                    │
│         Tailwind + shadcn/ui                             │
│         Communicates with backend via REST API            │
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
│  ┌──────────────┐               │ SearchService       │   │
│  │IngestionSvc  │──────────────→│ AuthService         │   │
│  │(orchestrates)│               └───────────────────┘   │
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
│  ┌──────────────┐  ┌──────────────┐                      │
│  │ JobService    │  │UploadService │  BullMQ + Redis      │
│  │ (queue mgmt)  │  │(chunked      │                      │
│  └──────────────┘  │ upload sess) │                      │
│                     └──────────────┘                     │
└──────────────────────┬──────────────────────────────────┘
                       │
          ┌────────────▼────────────┐
          │   PostgreSQL + Redis     │
          └─────────────────────────┘
```

---

## Service Inventory

### IngestionService

**Owns:** Upload and import orchestration, pipeline sequencing, Model record creation in "processing" state.

**Does not own:** File I/O, thumbnail generation, extraction logic, storage.

**Behavior:** Receives upload or import requests. Creates a Model record in `processing` state. Enqueues a processing job via JobService. The job worker calls back into IngestionService's pipeline methods, which coordinate FileProcessingService, ThumbnailService, StorageService, and MetadataService in sequence. On completion, updates model status to `ready` or `error`.

Two entry paths:
- **Zip upload**: Receives multipart file, stores temp file, enqueues processing job.
- **Folder import**: Receives ImportConfig (source path, pattern, strategy). Uses PatternParser to validate and parse the hierarchy pattern. Uses FileProcessingService to walk the directory. Uses the selected ImportStrategy to move files into managed storage. Then continues with the standard processing pipeline.

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

**Owns:** All query execution — browse, search, filter, sort, pagination. This is the single entry point for "give me models matching criteria."

**Does not own:** Data indexing, data mutation. SearchService is read-only.

**Behavior:** Accepts query parameters (text search, metadata filters, collection filter, sort, pagination cursor). Executes against Postgres full-text search in MVP. Understands which metadata fields use optimized storage (tags → join table query) vs. generic storage (other fields → model_metadata table query). Returns paginated results as model IDs which PresenterService then assembles into response payloads.

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

**Default fields** seeded on first run: Artist (text), Year (number), NSFW (boolean), URL (url), Pre-supported (boolean). These have `isDefault: true` and cannot be deleted.

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

## API Design

### Conventions

- **Routing:** Hybrid — flat routes for top-level resources, nested where hierarchy is real and single-parent (e.g., `/models/:id/files`).
- **Envelope:** Every response uses `{ data, meta, errors }`. No exceptions.
- **Pagination:** Cursor-based. `meta` includes `total`, `cursor` (null on last page), and `pageSize`.
- **Auth:** Session cookie on every request. Routes validate via AuthService middleware.

### Route Map

**Models**
| Method | Route | Purpose | Service Chain |
|--------|-------|---------|---------------|
| GET | /models | Browse/search with filters | SearchService → PresenterService |
| GET | /models/:id | Model detail | ModelService → PresenterService |
| GET | /models/:id/files | File tree | ModelService → PresenterService |
| POST | /models/upload | Upload archive (zip/rar/7z/tar.gz, ≤100 MB) | IngestionService → JobService |
| POST | /models/upload/init | Initiate chunked upload session | UploadService |
| PUT | /models/upload/:uploadId/chunk/:index | Upload a single chunk | UploadService |
| POST | /models/upload/:uploadId/complete | Assemble chunks, start ingestion | UploadService → IngestionService → JobService |
| POST | /models/import | Folder import | IngestionService → JobService |
| GET | /models/:id/status | Processing status | JobService |
| PATCH | /models/:id | Update model | ModelService → PresenterService |
| DELETE | /models/:id | Delete model + files | ModelService → StorageService |

**Collections**
| Method | Route | Purpose | Service Chain |
|--------|-------|---------|---------------|
| GET | /collections | List (with depth param) | CollectionService → PresenterService |
| GET | /collections/:id | Single collection | CollectionService → PresenterService |
| GET | /collections/:id/models | Models in collection | SearchService → PresenterService |
| POST | /collections | Create | CollectionService |
| PATCH | /collections/:id | Update | CollectionService → PresenterService |
| DELETE | /collections/:id | Delete (not its models) | CollectionService |
| POST | /collections/:id/models | Add model(s) | CollectionService |
| DELETE | /collections/:id/models/:modelId | Remove model | CollectionService |

**Metadata**
| Method | Route | Purpose | Service Chain |
|--------|-------|---------|---------------|
| GET | /metadata/fields | List all field definitions | MetadataService → PresenterService |
| POST | /metadata/fields | Create custom field | MetadataService |
| PATCH | /metadata/fields/:id | Update field definition | MetadataService |
| DELETE | /metadata/fields/:id | Delete (not defaults) | MetadataService |
| GET | /metadata/fields/:slug/values | Known values + counts | MetadataService → PresenterService |
| PATCH | /models/:id/metadata | Set/update metadata | MetadataService |

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
