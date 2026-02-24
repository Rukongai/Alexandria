# Alexandria — Knowledge Base

## What It Is

Alexandria is a self-hosted personal library manager for 3D printing model collections. It handles the upload, processing, organization, search, and browsing of 3D printing model files — typically distributed as zip archives containing STL files, images, and documentation. It is not a social platform or marketplace. It is a private archive tool: think of what Plex does for media libraries, applied to 3D printing files.

The problem it solves is scale. People who collect 3D printing models often have hundreds to thousands of models stored as zip files in folder hierarchies. Generic file managers don't understand the structure of a model package. Social platforms designed for sharing don't work well as personal archives. Alexandria fills that gap — a library manager that understands what a 3D printing collection looks like and provides the tools to manage it.

It is designed to run on a home server or NAS via Docker Compose. There is no cloud-hosted version, no accounts, and no telemetry. You run it, you own it.

## Technical Decisions and Rationale

Several decisions were made during the architecture phase and are treated as settled.

**One archive, one model.** An uploaded archive (zip, rar, 7z, tar.gz) always creates exactly one model entry. The archive boundary is the model boundary. No splitting, no multi-model extraction from a single upload.

**Metadata is unified, storage is not.** Tags, Artist, Year, NSFW, and user-defined custom fields are all accessed through the same metadata API. Internally, some field types (tags, which are multi-value enumeration) use a dedicated join table for query performance. This routing is invisible to the API and to the frontend. Adding a new field type does not require a new API surface — it is a new metadata field definition.

**Collections are not metadata.** Collections are organizational (where you put a model), not descriptive (what a model is). This is why Artist is a metadata field and Collections are a separate entity. A model can belong to multiple collections.

**Managed storage only.** After upload or import, Alexandria owns all files in its storage root. No runtime external file references. When importing an existing library folder, you choose a strategy: hardlink (zero additional disk usage on the same filesystem), copy, or move. Once imported, StorageService is the sole authority.

**Server-side response assembly.** PresenterService on the backend assembles all API response payloads into ready-to-render shapes before sending them. The frontend does not reshape or join data — it receives what it needs to display. This keeps frontend complexity low and makes response format changes a single-location concern.

**Cursor-based pagination everywhere.** No offset-based pagination. Cursor pagination is stable under concurrent mutations and performs better on large libraries.

**Auto-seed on startup.** The backend automatically runs database migrations and seeds default data (admin account, default metadata fields) on every startup before accepting traffic. Seeding is idempotent — it uses conflict-safe upserts and never overwrites existing data. Seed failures are non-fatal: the backend logs a warning and continues.

## Architecture Overview

Alexandria is a monorepo with three packages: a React frontend (`apps/frontend`), a Fastify backend (`apps/backend`), and a shared types and validation package (`packages/shared`).

The backend is organized around twelve focused services. Each service owns a coherent set of operations and does not reach into another service's internals.

- **IngestionService** — orchestrates the upload and import pipelines; creates model records and enqueues processing jobs
- **FileProcessingService** — extracts archives, walks import directories, classifies files by type, computes SHA-256 hashes
- **StorageService** — manages file storage; the local filesystem is the current implementation, with an S3-compatible implementation planned
- **ThumbnailService** — generates WebP thumbnails at grid and detail sizes using sharp
- **UploadService** — manages chunked upload sessions in memory, storing chunks to a temp directory and assembling them for ingestion
- **JobService** — manages BullMQ queues and job lifecycle
- **ModelService** — CRUD for Model and ModelFile records
- **MetadataService** — field definitions and metadata values, with internal routing for optimized field types (tags)
- **SearchService** — all query execution: full-text search, metadata filtering, sorting, cursor pagination
- **CollectionService** — collection CRUD, nesting, and model membership
- **AuthService** — single-user email/password auth with argon2 hashing and signed HTTP-only session cookies
- **PresenterService** — assembles API response payloads from domain data

Route handlers are thin: validate input, call a service, return the response envelope. All business logic lives in services. All response shaping lives in PresenterService. Services throw typed `AppError` instances for expected failures; the global error handler formats these as envelope responses.

The API uses a consistent `{ data, meta, errors }` envelope on every response without exception. Pagination uses cursors. All 32 endpoints are documented in `docs/API.md`.

## Deployment

Alexandria runs as four Docker Compose services: Postgres 16, Redis 7, the backend (Fastify on port 3001), and the frontend (Nginx on port 80). The backend and frontend are built from source in multi-stage Dockerfiles. All services have healthchecks. The backend waits for Postgres and Redis to be healthy before starting. SQL migration files are copied into the backend image at build time so the runtime container does not need access to source directories.

Storage is a named Docker volume mounted at `/data/storage` inside the backend container. Postgres data and Redis data are also named volumes, surviving container restarts.

Default credentials (`admin@alexandria.local` / `changeme`) are applied by the auto-seed on first startup. Override them with the `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, and `SEED_ADMIN_DISPLAY_NAME` environment variables before first run.

## Current Status

Phases 1 through 8 are complete. The full feature set described above — ingestion pipeline, metadata system, folder import, full-text search, collections, PresenterService API polish, and the React frontend — is implemented and reviewed. Chunked uploads (up to 5 GB with 10 MB chunks and automatic retry) were added after Phase 8.

Planned but not yet implemented: 3D model viewer (in-browser STL/3MF rendering), multi-user support, S3-compatible storage backend, and print job tracking.
