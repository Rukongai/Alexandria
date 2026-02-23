# Alexandria — Implementation Plan

This document breaks the project into ordered phases with clear dependencies, milestones, and acceptance criteria. Each phase builds on the previous one. The Orchestrator uses this document to determine what work to do next and to delegate to the appropriate specialist agent.

---

## Phase Overview

| Phase | Name | Depends On | Primary Agents |
|-------|------|-----------|----------------|
| 1 | Foundation | — | Database, Backend Service |
| 2 | Ingestion Pipeline | Phase 1 | Backend Service, Testing |
| 3 | Metadata System | Phase 1 | Backend Service, Database, Testing |
| 4 | Folder Import | Phase 2, Phase 3 | Backend Service, Testing |
| 5 | Search and Browse | Phase 3 | Backend Service, Testing |
| 6 | Collections | Phase 1 | Backend Service, Testing |
| 7 | PresenterService and API Polish | Phase 2-6 | Backend Service, Testing, Reviewer |
| 8 | Frontend | Phase 7 | Frontend, Testing |

Phases 3 and 6 can be worked in parallel — they don't depend on each other. Phase 4 depends on both 2 and 3. Phase 5 depends on 3. Phase 7 requires all backend phases to be complete. Phase 8 requires 7.

```
Phase 1 (Foundation)
├──→ Phase 2 (Ingestion) ──→ Phase 4 (Folder Import) ──┐
├──→ Phase 3 (Metadata) ──→ Phase 4 (Folder Import)    ├──→ Phase 7 (Presenter + Polish) ──→ Phase 8 (Frontend)
├──→ Phase 3 (Metadata) ──→ Phase 5 (Search)      ─────┤
└──→ Phase 6 (Collections) ────────────────────────────┘
```

---

## Phase 1 — Foundation

### Goal
Running development environment with database, auth, and the project skeleton. Proves the monorepo structure, shared types, Docker Compose, and database migrations all work.

### Work Items

**Monorepo Setup**
- Initialize workspace with package.json at root
- Configure Turborepo (turbo.json) with build/dev/lint tasks
- Create `apps/frontend` with Vite + React + TypeScript scaffold
- Create `apps/backend` with Fastify + TypeScript scaffold
- Create `packages/shared` with TypeScript compilation
- Verify cross-package imports work (shared types imported by both apps)

**Shared Types Package**
- Implement all types from TYPES.md in `packages/shared/src/types/`
- Implement shared constants (enums, defaults)
- Set up Zod validation schemas for auth requests
- Export everything from package index

**Database**
- Drizzle schema definitions for all entities: User, Model, ModelFile, Thumbnail, MetadataFieldDefinition, ModelMetadata, Tag, model_tags, Collection, collection_models
- Generate and verify initial migration
- Seed script for default metadata fields (Artist, Year, NSFW, URL, Pre-supported) and initial admin user
- Database connection module with configuration from environment variables

**Backend Skeleton**
- Fastify app setup with Pino logging
- Environment configuration module (DATABASE_URL, REDIS_URL, STORAGE_PATH, SESSION_SECRET, PORT)
- Global error handler implementing the envelope error format
- Request validation middleware using Zod schemas
- Health check endpoint: `GET /health` returns `{ status: 'ok' }`
- CORS configuration for frontend dev server

**Auth**
- AuthService: createUser, authenticate, validateSession, updateProfile
- Session middleware using Lucia or Auth.js
- Auth routes: POST /auth/login, POST /auth/logout, GET /auth/me, PATCH /auth/me
- Password hashing with bcrypt or argon2

**StorageService**
- Storage interface definition
- Local filesystem implementation
- Configuration for storage root path
- Basic operations: store, retrieve, delete, exists

**Docker Compose**
- Dockerfile.frontend (Node + Vite dev server for development, nginx for production)
- Dockerfile.backend (Node + Fastify)
- docker-compose.yml with services: frontend, backend, postgres, redis
- Volume mounts for storage and database persistence
- Environment variable configuration
- Health checks on all services

### Milestone Criteria
- `docker compose up` starts all services without errors
- Health check returns 200
- Database migrations run on startup
- Default metadata fields are seeded
- Can create a user and authenticate via API (curl/Postman)
- Session persists across requests
- Frontend dev server loads and can reach the backend API
- Shared types are importable in both apps

### Agent Assignments
- **Database Agent**: Schema definitions, migrations, seed script
- **Backend Service Agent**: Fastify skeleton, AuthService, StorageService, config, middleware
- **Orchestrator**: Monorepo setup, Docker Compose, wiring

---

## Phase 2 — Ingestion Pipeline

### Goal
Upload a zip file and have it fully processed: extracted, classified, thumbnailed, and stored. This proves the async job pipeline and the core service interactions.

### Work Items

**JobService**
- BullMQ connection setup with Redis
- Queue creation and management
- Job creation with typed payloads
- Job status querying
- Retry configuration (3 retries with exponential backoff)
- Job progress reporting

**IngestionService**
- Upload handler: receive multipart file, store temp file, create Model record in `processing` state, enqueue job
- Pipeline orchestration: called by worker, coordinates FileProcessingService → StorageService → ThumbnailService → ModelService
- Status update: set model to `ready` on success, `error` on failure
- Cleanup on failure: remove partially stored files if pipeline fails mid-way

**FileProcessingService**
- Zip extraction to temp directory
- File type classification based on extension and MIME type
- Supported image formats: jpg, jpeg, png, webp, tif
- STL detection
- Document detection (pdf, txt, md)
- Everything else classified as 'other'
- Metadata extraction: file count, total size, list of STL files, image count
- SHA-256 hash computation during file read (stream-through, not double-read)

**ThumbnailService**
- Image detection from classified files
- WebP conversion at defined sizes (grid: 400x400, detail: 800x800)
- Aspect ratio preservation (fit within bounds, don't stretch)
- Storage via StorageService
- Thumbnail record creation

**ModelService Updates**
- Create Model and ModelFile records from processing manifest
- Update model status
- Delete model with cascade to files and storage cleanup

**Routes**
- POST /models/upload — multipart file handler
- GET /models/:id/status — job progress

**Worker**
- ingestion.worker.ts — BullMQ worker that picks up ingestion jobs, calls IngestionService pipeline

### Milestone Criteria
- Upload a zip file via POST /models/upload
- Receive model ID and job status endpoint
- Poll status and watch it progress through phases
- Model reaches `ready` state
- Files are extracted and stored in managed storage with correct relative paths
- Images have webp thumbnails at both sizes
- All files have SHA-256 hashes
- ModelFile records have correct file types
- Uploading a corrupted zip results in `error` state with meaningful error message
- Re-uploading after failure works cleanly

### Agent Assignments
- **Backend Service Agent**: All services and routes
- **Testing Agent**: Integration tests for upload → status → ready flow, unit tests for file classification

---

## Phase 3 — Metadata System

### Goal
Fully functional metadata system with default fields, custom field creation, and the hybrid storage optimization for tags.

### Work Items

**MetadataService**
- Field definition CRUD (create, read, update, delete with protection for defaults)
- Metadata value assignment on models (set, update, remove)
- Storage routing: detect tag field (multi_enum default), route to tags/model_tags tables
- Generic storage path: all other fields go to model_metadata table
- Value listing: for a given field, list all known values with model counts
- Bulk metadata operations on multiple models

**Default Field Seeding Verification**
- Verify Phase 1 seed created correct default fields
- Artist (text, filterable, browsable)
- Year (number, filterable)
- NSFW (boolean, filterable)
- URL (url)
- Pre-supported (boolean, filterable)

**Routes**
- GET /metadata/fields
- POST /metadata/fields
- PATCH /metadata/fields/:id
- DELETE /metadata/fields/:id (reject for defaults)
- GET /metadata/fields/:slug/values
- PATCH /models/:id/metadata

**Bulk Routes**
- POST /bulk/metadata

### Milestone Criteria
- List default metadata fields via API
- Create a custom metadata field
- Assign tags to a model — verify data lands in tags/model_tags tables
- Assign artist to a model — verify data lands in model_metadata table
- API response for both looks identical (uniform MetadataValue shape)
- List all values for the tags field — returns tag names with model counts
- List all values for the artist field — returns artist names with model counts
- Bulk assign tags to multiple models
- Cannot delete default fields
- Can delete custom fields (removes values from all models)

### Agent Assignments
- **Backend Service Agent**: MetadataService, routes
- **Database Agent**: Verify indexes on model_tags and model_metadata for filter performance
- **Testing Agent**: Unit tests for storage routing logic, integration tests for CRUD operations

---

## Phase 4 — Folder Import

### Goal
Point at an existing directory with a user-defined hierarchy pattern, and have Alexandria import the models with correct metadata and collection assignments.

### Work Items

**PatternParser**
- Parse pattern string into structured segments
- Validate: must end with `{model}`, valid segment types, no `{model}` in middle
- Return ParsedPatternSegment array

**FileProcessingService Updates**
- Directory walking: recursively traverse a directory tree
- Pattern matching: given a parsed pattern and a directory tree, map each directory level to its meaning (collection, metadata value, model root)
- Everything below the model level in the pattern becomes ModelFiles

**Import Strategies**
- ImportStrategy interface: `execute(sourcePath: string, targetPath: string): Promise<void>`
- HardlinkStrategy: validate same-filesystem, create hardlinks, fallback to copy with warning
- CopyStrategy: copy files to managed storage
- MoveStrategy: move files to managed storage

**IngestionService Updates**
- Import handler: receive ImportConfig, validate pattern, validate source path accessibility
- Orchestrate: parse pattern → walk directory → match pattern → execute strategy → process each discovered model through standard pipeline
- Progress reporting: total models discovered, models processed, models failed
- Create collections from pattern if they don't exist

**Routes**
- POST /models/import

### Milestone Criteria
- Define pattern `{metadata.Artist}/{model}` and point at a directory with artist/model structure
- Models are created with correct artist metadata assigned
- Define pattern `{Collection}/{metadata.Artist}/{model}` — collections are created and models assigned
- All three local strategies work: hardlink (same filesystem), copy, move
- Hardlink on different filesystem falls back to copy with warning in logs
- Move removes original files
- Large import (100+ models) shows progress and completes without errors
- Invalid pattern is rejected with clear error message
- Inaccessible source path is rejected with clear error message

### Agent Assignments
- **Backend Service Agent**: PatternParser, strategies, IngestionService updates
- **Testing Agent**: Unit tests for PatternParser, integration tests for each strategy, end-to-end import test

---

## Phase 5 — Search and Browse

### Goal
Browse the full library with text search, metadata filtering, sorting, and cursor-based pagination.

### Work Items

**SearchService**
- Search interface definition
- Postgres full-text search implementation
- Text search across model name, description
- Metadata filtering: translate filter params to queries against appropriate backing storage
  - Tags: query via model_tags join
  - Other metadata: query via model_metadata table
- Collection filtering: query via collection_models join
- File type presence filter: query for models that have at least one file of the specified type
- Status filter
- Sorting: by name, createdAt, totalSizeBytes (asc/desc)
- Cursor-based pagination: encode cursor from sort field + id, decode on next request
- Total count computation

**Routes**
- GET /models (replaces any placeholder from earlier phases)

### Milestone Criteria
- Browse all models with default sort and pagination
- Text search returns relevant results ranked by relevance
- Filter by tags — returns only models with matching tags
- Filter by artist — returns only models with matching artist metadata
- Combine text search with metadata filters — intersection, not union
- Sort by each supported field in both directions
- Cursor pagination: request page 1, use cursor to get page 2, verify no duplicates or gaps
- Empty result set returns correct envelope with empty data array and total: 0
- Performance: search across 500 models completes in under 200ms

### Agent Assignments
- **Backend Service Agent**: SearchService implementation
- **Database Agent**: Full-text search index setup, query optimization review
- **Testing Agent**: Integration tests for each filter type and combination, pagination edge cases

---

## Phase 6 — Collections

### Goal
Full collection management with nesting, model membership, and tree operations.

### Work Items

**CollectionService**
- Collection CRUD
- Parent-child nesting: assign parent, move collection, get children, get ancestors
- Model membership: add models, remove models, list models in collection
- Tree expansion: return nested children to specified depth
- Deletion behavior: deleting a collection removes the collection and its membership records, not the models themselves. Child collections become top-level (parent set to null).

**Routes**
- GET /collections
- GET /collections/:id
- GET /collections/:id/models (delegates to SearchService with collection filter)
- POST /collections
- PATCH /collections/:id
- DELETE /collections/:id
- POST /collections/:id/models
- DELETE /collections/:id/models/:modelId

**Bulk Routes**
- POST /bulk/collection

### Milestone Criteria
- Create collection, nest inside another collection
- Add model to multiple collections
- Browse models in a collection (paginated)
- List collections with depth expansion
- Move collection to different parent
- Delete collection — models remain, child collections become top-level
- Bulk add/remove models from collection
- Circular nesting prevention (collection cannot be its own ancestor)

### Agent Assignments
- **Backend Service Agent**: CollectionService, routes
- **Testing Agent**: Integration tests for CRUD, tree operations, circular reference prevention

---

## Phase 7 — PresenterService and API Polish

### Goal
All API responses are properly shaped by PresenterService. All endpoints return consistent envelope responses. The API is complete and ready for frontend consumption.

### Work Items

**PresenterService**
- buildModelCard: assemble compact model card from model + metadata + thumbnail
- buildModelDetail: assemble full detail from model + metadata + collections + images + thumbnail
- buildFileTree: convert flat ModelFile relativePaths into nested FileTreeNode structure
- buildCollectionDetail: collection + children + model count
- buildMetadataFieldList: field definitions with value counts
- Thumbnail URL resolution: convert storage paths to servable URLs

**Route Refactoring**
- All existing routes updated to use PresenterService for response assembly
- Verify every response uses the envelope format
- Verify error responses use the envelope format

**Static File Serving**
- Route for serving stored files (images, thumbnails, STLs)
- Appropriate caching headers
- Correct content-type headers

**Bulk Operations**
- POST /bulk/delete (Model deletion with storage cleanup)

### Milestone Criteria
- Every API endpoint returns `{ data, meta, errors }` envelope
- ModelCard responses are compact and contain everything the grid view needs
- ModelDetail responses include assembled metadata, gallery, file tree
- File tree is correctly nested from flat paths
- Thumbnails are served and reachable via URL in responses
- Original images are served and reachable
- Reviewer agent confirms no service boundary violations, no type duplication, no convention violations across the full backend codebase

### Agent Assignments
- **Backend Service Agent**: PresenterService, route refactoring, file serving
- **Testing Agent**: Integration tests for every endpoint's response shape
- **Reviewer Agent**: Full backend review
- **Documentation Agent**: Repository documentation for backend API

---

## Phase 8 — Frontend

### Goal
Complete browsing and management UI for Alexandria.

### Work Items

This phase is large and should be broken into sub-milestones by the Orchestrator during execution. The ordering below is suggested but can be adjusted based on implementation flow.

**Sub-milestone 8a: Shell and Auth**
- React app scaffolding: routing, layout, Tailwind configuration, shadcn/ui setup
- API client layer with typed functions for all endpoints
- Login page and auth flow
- Session persistence and redirect-on-unauthorized
- App shell: navigation sidebar, header, content area

**Sub-milestone 8b: Library Grid**
- Model card component (thumbnail, name, tags, file count, status indicator)
- Library grid view with responsive layout
- Infinite scroll with cursor-based pagination
- Loading and empty states

**Sub-milestone 8c: Search and Filter**
- Search bar with text input
- Metadata filter panel (tags, artist, other filterable fields)
- Collection filter (sidebar tree)
- Sort controls
- Active filter display with clear buttons
- URL-driven filter state (shareable/bookmarkable search URLs)

**Sub-milestone 8d: Model Detail**
- Model detail page with image gallery
- Gallery: thumbnail grid, click to expand, navigate between images
- File tree viewer with expand/collapse
- Metadata display grouped by field
- Metadata inline editing
- Collection membership display
- Basic model info editing (name, description)

**Sub-milestone 8e: Upload and Import**
- Zip upload: drag-and-drop zone, file selection, progress indicator
- Upload status tracking: polling job status, showing progress
- Folder import: source path input, pattern builder UI (visual segment picker), strategy selection
- Import progress view for large imports

**Sub-milestone 8f: Organization**
- Collection management: create, edit, delete, nest (drag to reorder/nest in sidebar)
- Metadata field management: create custom fields, configure filterable/browsable
- Bulk selection mode: checkbox on model cards, bulk action toolbar (tag, collect, delete)

### Milestone Criteria
- Complete workflow: log in → import folder → browse grid → search/filter → open detail → edit metadata → manage collections → upload zip → browse updated library
- Responsive at common screen sizes (desktop, tablet)
- Loading and error states throughout
- Empty states for new libraries (no models yet, no collections yet)
- Accessible: keyboard navigation, screen reader basics, sufficient contrast

### Agent Assignments
- **Frontend Agent**: All sub-milestones
- **Testing Agent**: Component tests for complex interactive elements
- **Reviewer Agent**: Final cross-project review
- **Documentation Agent**: Repository docs (README, setup guide) and knowledge base doc

---

## Post-MVP Phases (Documented, Not Scheduled)

These are referenced in the project outline but not scheduled for implementation. They're documented here so the architecture can accommodate them without retrofitting.

**Phase 9 — S3 Storage**
- S3-compatible StorageService implementation
- S3UploadStrategy for folder import with hash-verified deletion
- Configuration for S3 endpoint, bucket, credentials

**Phase 10 — SQLite Mode**
- Drizzle schema compatibility for SQLite
- Search implementation for SQLite (without Postgres FTS)
- Configuration toggle for database engine

**Phase 11 — 3D Viewer**
- react-three-fiber STL viewer component
- Client-side or server-side 3D thumbnail generation

**Phase 12 — Multi-User and Permissions**
- Role-based access control
- Per-collection permission grants
- OIDC/OAuth integration

**Phase 13 — Dynamic Metadata Rules**
- MetadataRule entity
- Rule evaluation during ingestion pipeline
- Rule management UI

**Phase 14 — Print Integration**
- PrintJob entity and tracking
- Slicer API integration
