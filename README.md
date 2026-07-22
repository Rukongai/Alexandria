# Alexandria

A self-hosted personal library for managing 3D printing model collections. Think of it as Plex for 3D printing files — upload archives, and Alexandria handles processing, thumbnail generation, metadata, organization, and search.

![Alexandria preview](docs/preview.png)

---

## Features

**Ingestion and storage**
- Upload `.zip`, `.rar`, `.7z`, `.tar.gz`, and `.tgz` archives containing STL files, images, and supporting documents
- Combine 2–100 independent archives into one model, or upload every part of one supported split archive (`.z01` … `.zip`, `.zip.001` …, or modern `.partN.rar`)
- Chunked uploads up to 5 GB per file with 10 MB chunks and automatic retry
- Async processing pipeline with thumbnail generation (WebP at multiple sizes)
- Import existing library folders with pattern-based hierarchy parsing (e.g. `{artist}/{year}/{name}`) using hardlink, copy, or move strategies
- Store managed files on the local filesystem or in a private S3-compatible bucket, including MEGA S4

**Organization**
- Flexible metadata system with default fields (Artist, Year, Tags, NSFW, Pre-supported, URL) and user-defined custom fields
- Nestable collections — models can belong to multiple collections simultaneously
- Existing tag values are suggested during model editing, upload review, and bulk tagging; free-form tags remain supported
- Tag normalization prevents case-variant duplicates

**Search and browse**
- PostgreSQL full-text search across model names and descriptions
- Filter by any metadata field value
- Cursor-based pagination for efficient large library browsing

**AI assistant**
- Connect user-owned, OpenAI-compatible providers; API keys are encrypted at rest and never returned by the API
- Search and inspect the active library, research public sources, and prepare reviewable model, metadata, cover, or collection changes
- Enforce preview-before-apply with immutable, expiring, single-use proposals applied atomically

**API**
- Typed REST endpoints with a consistent `{ data, meta, errors }` envelope on every response
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
| Storage | Local filesystem or S3-compatible object storage |
| Auth | Session cookie with argon2 password hashing |
| Deployment | Docker Compose |
| Monorepo | npm workspaces + Turborepo |

---

## Quick Start

Requires Docker and Docker Compose.

```bash
git clone <repo-url> alexandria
cd alexandria
cp .env.example .env

# Replace SESSION_SECRET and AI_ENCRYPTION_KEY with long random values.

# Start all services (Postgres, Redis, backend, frontend)
docker compose -f docker/docker-compose.yml up --build
```

On first startup, the backend automatically runs database migrations and seeds the default admin account and metadata fields. No manual seeding step is required.

Services are available at:

- Frontend: http://localhost:80
- Backend API: http://localhost:3001
- Postgres: localhost:5433 (user: `alexandria`, password: `alexandria`, db: `alexandria`)

Default login: `admin@alexandria.local` / `changeme`

To use a custom admin account, set `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, and `SEED_ADMIN_DISPLAY_NAME` in your environment before the first startup. The seed is idempotent — it uses `ON CONFLICT DO NOTHING`, so re-running it does not overwrite existing data.

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
│   │       ├── services/   Business logic services
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
| `STORAGE_BACKEND` | `local` | Managed storage provider: `local` or `s3` |
| `STORAGE_PATH` | `./data/storage` | Local managed-storage root; also the migration source when using S3 |
| `S3_ENDPOINT` | AWS SDK default | Custom S3-compatible endpoint URL; omit for AWS S3 |
| `S3_REGION` | `us-east-1` | S3 signing region |
| `S3_BUCKET` | — | Bucket name; required when `STORAGE_BACKEND=s3` |
| `S3_PREFIX` | empty | Optional object-key prefix, without a leading slash |
| `S3_FORCE_PATH_STYLE` | `false` | Use path-style instead of virtual-hosted-style bucket URLs |
| `SESSION_SECRET` | `dev-secret-change-in-production` | Secret for signing session cookies |
| `AI_ENCRYPTION_KEY` | _(required in production)_ | Stable secret used to encrypt provider API keys; production rejects values under 32 characters, `SESSION_SECRET`, and checked placeholders |
| `AI_ALLOW_PRIVATE_PROVIDER_URLS` | `true` in development; `false` in production | Allow trusted loopback/LAN AI providers; link-local, cloud-metadata, and reserved targets remain blocked |
| `PORT` | `3000` | Port the backend listens on |
| `HOST` | `0.0.0.0` | Host the backend binds to |
| `NODE_ENV` | `development` | Affects log level and cookie security |

Keep `AI_ENCRYPTION_KEY` stable for the lifetime of the stored provider configurations. Changing it makes existing encrypted API keys unreadable. Configure only trusted provider base URLs; the backend connects to them directly and validates their resolved addresses before saving and use. Public providers must use HTTPS. Set `AI_ALLOW_PRIVATE_PROVIDER_URLS=true` in production only when a trusted same-host or LAN provider is intentional; this is also required for an HTTP loopback/LAN provider. Assistant public lookup makes outbound requests to DuckDuckGo and Wikimedia Commons when the selected provider invokes those tools.

Seed variables (read on every startup and by `npm run db:seed`):

| Variable | Default | Description |
|---|---|---|
| `SEED_ADMIN_EMAIL` | `admin@alexandria.local` | Admin account email |
| `SEED_ADMIN_PASSWORD` | `changeme` | Admin account password |
| `SEED_ADMIN_DISPLAY_NAME` | `Admin` | Admin display name |

S3 credentials are resolved through the AWS SDK default credential chain. For a simple deployment, set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and, for temporary credentials, `AWS_SESSION_TOKEN`. Workload roles, shared AWS configuration, and the other standard providers are also supported. The backend validates S3 bucket access before migrations or HTTP startup and exits if validation fails.

See [`docs/STORAGE.md`](docs/STORAGE.md) for provider configuration, MEGA S4 compatibility, private-object delivery, and local-to-S3 migration.

---

## Testing

```bash
npm run test
```

Tests run with Vitest and live alongside source files. Integration tests require a running Postgres and Redis instance. Point `DATABASE_URL` at a local or Docker-hosted Postgres before running.

```bash
# Start only the infrastructure services for testing. Compose still resolves
# the backend environment, so provide a test-only encryption value.
AI_ENCRYPTION_KEY=test-only-not-for-production docker compose -f docker/docker-compose.yml up -d postgres redis
```

---

## Documentation

- `docs/ARCHITECTURE.md` — service boundaries, API design, and decision log
- `docs/API.md` — full API reference (64 endpoints)
- `docs/TYPES.md` — canonical type definitions
- `docs/CONVENTIONS.md` — naming, patterns, and coding standards
- `docs/STORAGE.md` — local and S3-compatible storage configuration and migration
- `docs/PROJECT-BRIEF.md` — project overview and rationale

---

## Roadmap

The following are planned but not yet implemented:

- **3D model viewer** — in-browser STL/3MF rendering
- **Multi-user support** — roles, per-user collections, shared libraries
- **Print job tracking** — link models to print history and notes
