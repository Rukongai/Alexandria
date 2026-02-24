# Alexandria

A self-hosted personal library for managing 3D printing model collections. Think of it as Plex for 3D printing files — upload your zip archives, and Alexandria handles processing, thumbnail generation, metadata, organization, and search.

![Alexandria preview](docs/preview.png)

---

## Features

**Ingestion and storage**
- Upload zip archives containing STL files, images, and supporting documents
- Chunked uploads up to 5 GB with 10 MB chunks and automatic retry
- Async processing pipeline with thumbnail generation (WebP at multiple sizes)
- Import existing library folders with pattern-based hierarchy parsing (e.g. `{artist}/{year}/{name}`) using hardlink, copy, or move strategies

**Organization**
- Flexible metadata system with default fields (Artist, Year, Tags, NSFW, Pre-supported, URL) and user-defined custom fields
- Nestable collections — models can belong to multiple collections simultaneously
- Tag normalization prevents case-variant duplicates

**Search and browse**
- PostgreSQL full-text search across model names and descriptions
- Filter by any metadata field value
- Cursor-based pagination for efficient large library browsing

**API**
- 32 REST endpoints with a consistent `{ data, meta, errors }` envelope on every response
- Serves thumbnails and raw model files directly

**Auth**
- Single-user email/password login with HTTP-only signed session cookie
- argon2 password hashing

---

## Tech Stack

| Layer | Choice |
|---|---|
| Frontend | React 19 + Vite + TypeScript, Tailwind CSS + shadcn/ui |
| Backend | Fastify 5 + TypeScript |
| Database | PostgreSQL 16, Drizzle ORM |
| Job Queue | BullMQ + Redis |
| Storage | Local filesystem |
| Auth | Session cookie with argon2 password hashing |
| Deployment | Docker Compose |
| Monorepo | npm workspaces + Turborepo |

---

## Quick Start

Requires Docker and Docker Compose.

```bash
git clone <repo-url> alexandria
cd alexandria

# Start all services (Postgres, Redis, backend, frontend)
docker compose -f docker/docker-compose.yml up --build

# Seed the database (first time only)
docker compose -f docker/docker-compose.yml exec backend npm run db:seed
```

Services are available at:

- Frontend: http://localhost:5173
- Backend API: http://localhost:3001
- Postgres: localhost:5433 (user: `alexandria`, password: `alexandria`, db: `alexandria`)

Default login after seeding: `admin@alexandria.local` / `changeme`

---

## Development Setup

Requires Node.js 20 or later.

```bash
npm install
npm run dev
```

`npm run dev` runs Turborepo's dev task across all packages. The backend uses `tsx watch` and the frontend uses Vite's dev server with hot reload. The frontend dev server proxies `/api/*` requests to `http://localhost:3000`.

To run a single app:

```bash
cd apps/backend && npm run dev
cd apps/frontend && npm run dev
```

### Database

Drizzle migrations run automatically on backend startup. To run them manually or generate new ones after schema changes:

```bash
cd apps/backend
npm run db:migrate    # Apply pending migrations
npm run db:generate   # Generate migration after schema changes
npm run db:seed       # Seed default user and metadata fields
```

For local development outside Docker, the backend connects to `postgresql://alexandria:alexandria@localhost:5432/alexandria` by default. Override with `DATABASE_URL`.

---

## Project Structure

```
alexandria/
├── apps/
│   ├── backend/            Fastify API server
│   │   └── src/
│   │       ├── routes/     Thin route handlers
│   │       ├── services/   Business logic (12 services)
│   │       ├── workers/    BullMQ workers
│   │       ├── db/
│   │       │   ├── schema/ Drizzle table definitions
│   │       │   └── migrations/
│   │       ├── middleware/ Auth, validation, error handler
│   │       ├── config/     Environment configuration
│   │       └── utils/      AppError, logger, slug, format
│   │
│   └── frontend/           Vite + React 19
│       └── src/
│           ├── api/        Typed API clients
│           ├── components/ UI components (shadcn/ui + custom)
│           ├── hooks/      Auth, filters, selection, toast
│           └── pages/      All application pages
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
└── docs/                   Architecture, API reference, types, conventions
```

---

## Environment Variables

All backend variables have development defaults and can be set in the environment or a `.env` file.

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://alexandria:alexandria@localhost:5432/alexandria` | Postgres connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `STORAGE_PATH` | `./data/storage` | Root path for managed file storage |
| `SESSION_SECRET` | `dev-secret-change-in-production` | Secret for signing session cookies |
| `PORT` | `3000` | Port the backend listens on |
| `HOST` | `0.0.0.0` | Host the backend binds to |
| `NODE_ENV` | `development` | Affects log level and cookie security |

Seed-only variables (read by `npm run db:seed`):

| Variable | Default | Description |
|---|---|---|
| `SEED_ADMIN_EMAIL` | `admin@alexandria.local` | Admin account email |
| `SEED_ADMIN_PASSWORD` | `changeme` | Admin account password |
| `SEED_ADMIN_DISPLAY_NAME` | `Admin` | Admin display name |

---

## Testing

```bash
npm run test
```

Tests run with Vitest and live alongside source files. Integration tests require a running Postgres and Redis instance. Point `DATABASE_URL` at a local or Docker-hosted Postgres before running.

```bash
# Start only the infrastructure services for testing
docker compose -f docker/docker-compose.yml up -d postgres redis
```

---

## Documentation

- `docs/ARCHITECTURE.md` — service boundaries, API design, and decision log
- `docs/API.md` — full API reference (32 endpoints)
- `docs/TYPES.md` — canonical type definitions
- `docs/CONVENTIONS.md` — naming, patterns, and coding standards
- `docs/PROJECT-BRIEF.md` — project overview and rationale

---

## Roadmap

The following are planned but not yet implemented:

- **3D model viewer** — in-browser STL/3MF rendering
- **Multi-user support** — roles, per-user collections, shared libraries
- **S3-compatible storage** — swap local filesystem for object storage
- **Print job tracking** — link models to print history and notes
