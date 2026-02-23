# Alexandria

A self-hosted personal library for managing 3D printing model collections. Handles upload, processing, organization, and search of model files (STLs, images, supporting documents) packaged as zip archives.

Think of it as Plex for 3D printing files.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Frontend | React 19 + Vite + TypeScript, Tailwind CSS |
| Backend | Fastify 5 + TypeScript |
| Database | PostgreSQL 16, Drizzle ORM |
| Job Queue | BullMQ + Redis (Phase 2+) |
| Storage | Local filesystem (S3-compatible planned) |
| Auth | Session cookie with argon2 password hashing |
| Deployment | Docker Compose |
| Monorepo | npm workspaces + Turborepo |

---

## Prerequisites

- Node.js 20 or later
- Docker and Docker Compose

---

## Quick Start (Docker Compose)

```bash
git clone <repo-url> alexandria
cd alexandria

# Start all services (Postgres, Redis, backend, frontend)
docker compose -f docker/docker-compose.yml up --build

# In a separate terminal, seed the database (first time only)
docker compose -f docker/docker-compose.yml exec backend npm run db:seed
```

Services are available at:

- Frontend: http://localhost:5173
- Backend API: http://localhost:3001
- Postgres: localhost:5433 (user: `alexandria`, password: `alexandria`, db: `alexandria`)

Default admin credentials after seeding: `admin@alexandria.local` / `changeme`

Set `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, and `SEED_ADMIN_DISPLAY_NAME` environment variables before seeding to override the defaults.

---

## Development Setup

Install dependencies from the repo root:

```bash
npm install
```

Start all services in development mode (with watch/hot-reload):

```bash
npm run dev
```

This runs Turborepo's `dev` task across all packages. The backend uses `tsx watch` and the frontend uses Vite's dev server.

To run services individually:

```bash
# Backend only
cd apps/backend && npm run dev

# Frontend only
cd apps/frontend && npm run dev
```

The frontend dev server proxies `/api/*` requests to `http://localhost:3000` (the backend's default development port). When running via Docker Compose, the backend is exposed on host port 3001.

### Database

The backend runs Drizzle migrations automatically on startup. To run migrations or generate new ones manually:

```bash
cd apps/backend

# Apply pending migrations
npm run db:migrate

# Generate a new migration after schema changes
npm run db:generate

# Seed the database with default user and metadata fields
npm run db:seed
```

You need a running Postgres instance. When developing outside Docker, the backend defaults to `postgresql://alexandria:alexandria@localhost:5432/alexandria`. Override with `DATABASE_URL`.

---

## Project Structure

```
alexandria/
├── apps/
│   ├── backend/            Fastify API server
│   │   └── src/
│   │       ├── routes/     Thin route handlers (auth implemented in Phase 1)
│   │       ├── services/   Business logic services
│   │       ├── db/
│   │       │   ├── schema/ Drizzle table definitions (all entities defined)
│   │       │   └── migrations/
│   │       ├── middleware/ Auth, validation, error handler
│   │       ├── config/     Environment configuration
│   │       └── utils/      AppError and error factories
│   │
│   └── frontend/           Vite + React scaffold
│
├── packages/
│   └── shared/             Types, constants, and Zod schemas shared by both apps
│       └── src/
│           ├── types/      Canonical type definitions
│           ├── constants/  Enums, defaults, error codes
│           └── validation/ Zod schemas for request validation
│
├── docker/
│   ├── docker-compose.yml
│   ├── Dockerfile.backend
│   └── Dockerfile.frontend
│
└── docs/                   Architecture, types, conventions, and plan
```

---

## Environment Variables

The backend reads these from the environment. All have development defaults.

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://alexandria:alexandria@localhost:5432/alexandria` | Postgres connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `STORAGE_PATH` | `./data/storage` | Root path for managed file storage |
| `SESSION_SECRET` | `dev-secret-change-in-production` | Secret for signing session cookies |
| `PORT` | `3000` | Port the backend listens on |
| `HOST` | `0.0.0.0` | Host the backend binds to |
| `NODE_ENV` | `development` | Affects log level and cookie security |

Seed-only variables (only read by `npm run db:seed`):

| Variable | Default | Description |
|---|---|---|
| `SEED_ADMIN_EMAIL` | `admin@alexandria.local` | Admin account email |
| `SEED_ADMIN_PASSWORD` | `changeme` | Admin account password |
| `SEED_ADMIN_DISPLAY_NAME` | `Admin` | Admin display name |

---

## Current Status

Phase 1 (Foundation) is complete. What's built:

- Full monorepo setup with shared types package
- All database schemas defined and migrated (User, Model, ModelFile, Thumbnail, MetadataFieldDefinition, ModelMetadata, Tag, Collection, and all join tables)
- AuthService with argon2 password hashing, session cookies, and profile management
- StorageService local filesystem implementation with the `IStorageService` interface
- Auth routes: `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `PATCH /auth/me`
- Global error handler producing the `{ data, meta, errors }` envelope on all errors
- Request validation middleware using shared Zod schemas
- Health check: `GET /health`
- Database seed with default admin user and six metadata fields (Tags, Artist, Year, NSFW, URL, Pre-supported)
- Docker Compose setup with health checks on all services

Phases 2–8 (ingestion pipeline, metadata, folder import, search, collections, API polish, frontend UI) are planned. See `docs/PLAN.md`.

---

## Documentation

- `docs/ARCHITECTURE.md` — service boundaries, API design, and decision log
- `docs/TYPES.md` — canonical type definitions
- `docs/CONVENTIONS.md` — naming, patterns, and coding standards
- `docs/PLAN.md` — phase-by-phase implementation plan
- `docs/PROJECT-BRIEF.md` — project overview and rationale
