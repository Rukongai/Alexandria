# Alexandria — Project Brief

## What It Is

Alexandria is a self-hosted personal library for managing 3D printing model collections. It handles the upload, processing, organization, browsing, and search of 3D printing model files — typically distributed as zip archives containing STL files, images, documentation, and variant parts.

Unlike platforms like Thingiverse or MyMiniFactory, Alexandria isn't a social platform or marketplace. It's a private archive tool. Think of it as what Plex is for media libraries, applied to 3D printing files.

## Why It Exists

People who collect 3D printing models accumulate large libraries (hundreds to tens of thousands of models) stored as zip files in folder hierarchies. There's no good tool for managing these collections — most people rely on folder structures and file names, which breaks down at scale. Existing solutions are either social-sharing platforms that don't work well as personal archives, or generic file managers that don't understand the structure and metadata of 3D printing model packages.

Alexandria fills this gap: a library manager that understands what a 3D printing model collection looks like and provides the browsing, search, and organizational tools to manage it.

## Scope

### What Alexandria Does (MVP)

- **Ingests models** from zip uploads and existing folder-based libraries with user-defined hierarchy patterns
- **Processes uploaded files** asynchronously — extracts zips, classifies files by type, generates image thumbnails, computes file hashes
- **Provides flexible metadata** — ships with default fields (Artist, Year, Tags, NSFW, Pre-supported, URL) and supports user-defined custom fields. Tags have optimized query performance under the hood.
- **Organizes via collections** — nestable collection hierarchy, models can belong to multiple collections
- **Supports import strategies** — hardlink (zero-copy on same filesystem), copy, or move for importing existing libraries
- **Full-text search and filtering** — search across names and descriptions, filter by any metadata field, sort and paginate with cursor-based pagination
- **Single-user auth** — local email/password authentication with session management

### What Alexandria Doesn't Do (Yet)

- No 3D model viewer (planned for Phase 11)
- No multi-user support or permissions (planned for Phase 12)
- No S3/cloud storage (planned for Phase 9)
- No print job tracking or slicer integration (planned for Phase 14)
- No mobile-specific UI (general responsive design, but not mobile-optimized)

## Key Design Decisions

These decisions were made deliberately during the architecture phase and should not be reversed without revisiting the rationale.

**Zip = one model.** An uploaded zip always creates exactly one model entry. The contents are its files. No splitting, no multi-model extraction.

**Metadata is unified.** Tags, Artist, Year, NSFW — all are metadata fields. The system doesn't have separate entity types for each. Some fields (like tags) have optimized database storage for query performance, but this is invisible to the API and UI. New attribute types are added by creating new metadata fields, not new database entities.

**Collections are not metadata.** Collections are organizational (where you put a model), not descriptive (what a model is). This is why collections remain a separate concept while Artist became a metadata field.

**Managed storage only.** After import, Alexandria owns all files. No external file references at runtime. Import strategies (hardlink, copy, move) control how files enter managed storage, but once they're in, StorageService is the sole authority.

**Server-side response assembly.** PresenterService on the backend builds all API response payloads. The frontend receives ready-to-render data shapes. This keeps frontend complexity low and provides a single place to change response formats.

**Cursor-based pagination everywhere.** No offset pagination. Better performance at scale, stable under mutations.

## Tech Stack

| Layer | Choice |
|-------|--------|
| Frontend | React + Vite + TypeScript, Tailwind CSS + shadcn/ui |
| Backend | Fastify + TypeScript |
| Database | PostgreSQL (primary), Drizzle ORM |
| Job Queue | BullMQ + Redis |
| Storage | Local filesystem (S3-compatible planned) |
| Auth | Lucia or Auth.js (session-based) |
| Deployment | Docker Compose |
| Monorepo | Turborepo with shared types package |

## Architecture Summary

The backend is organized around 11 services with clear ownership boundaries:

- **IngestionService** — orchestrates upload and import pipelines
- **FileProcessingService** — extracts zips, walks folders, classifies files
- **StorageService** — manages blob storage (local filesystem, future S3)
- **ThumbnailService** — generates webp thumbnails from images
- **MetadataService** — manages field definitions and metadata values with hybrid storage
- **ModelService** — CRUD for models and their files
- **SearchService** — all querying, filtering, sorting, pagination
- **CollectionService** — collection management and nesting
- **AuthService** — authentication and sessions
- **JobService** — async job queue management
- **PresenterService** — assembles API response payloads

The frontend communicates with the backend via a REST API using a consistent response envelope (`{ data, meta, errors }`) on every endpoint.

## Implementation Plan

The project is built in 8 phases, ordered by dependency:

1. **Foundation** — monorepo, database, auth, Docker Compose
2. **Ingestion Pipeline** — zip upload, processing, thumbnails
3. **Metadata System** — field definitions, values, hybrid storage
4. **Folder Import** — pattern parser, import strategies
5. **Search and Browse** — full-text search, filtering, pagination
6. **Collections** — CRUD, nesting, model membership
7. **PresenterService and Polish** — response assembly, API consistency
8. **Frontend** — complete browsing and management UI

Implementation uses a team of 7 specialized Claude Code agents (Orchestrator, Backend, Frontend, Database, Testing, Reviewer, Documentation) designed to manage context window limits by keeping each agent focused on its domain.

## Current Status

Architecture complete. Implementation not yet started.
