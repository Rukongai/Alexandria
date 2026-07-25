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
- Run against the bundled PostgreSQL container or a hosted PostgreSQL service

**Organization**
- Flexible metadata system with default fields (Artist, Year, Tags, NSFW, Pre-supported, URL, Source) and user-defined custom fields
- Nestable collections — models can belong to multiple collections simultaneously
- Library-scoped bulk metadata, collection, and delete operations validate up to 500 models and apply database changes atomically
- Existing tag values are suggested during model editing, upload review, and bulk tagging; free-form tags remain supported
- Tag normalization trims and validates names and prevents case-variant duplicates

**Search and browse**
- PostgreSQL full-text search across model names and descriptions
- Filter by any metadata field value
- Cursor-based pagination for efficient large library browsing
- Lazy-loaded in-browser STL viewer with multi-file switching and orbit controls

**AI assistant**
- Connect user-owned, OpenAI-compatible providers; API keys are encrypted at rest and never returned by the API
- Search models, collections, metadata fields and known values, and staged uploads in the active library; research public sources; and prepare reviewable model or upload-draft changes
- Use the current detail, page selection, or upload review as context, with starter tasks for filling metadata and suggesting tags or collections
- Preview one uniform metadata or collection operation across the current models or active library; the server freezes up to 500 owned targets and shows the resolved scope, count, and a bounded model-name sample
- Try `{Artist Name} - {Date} - {Model Name}` filenames when filling metadata and infer Source as the character's originating work when evidence supports it
- Enforce preview-before-apply with immutable, expiring, single-use individual and bulk proposals applied atomically; staged proposals update review metadata but never commit an upload

**Local MCP server**
- Connect a trusted local MCP client over stdio to search and inspect raw model records, download managed files, and update, merge, delete, or tag models within one operator-configured user and library scope
- See [`docs/MCP.md`](docs/MCP.md) for tool details, client configuration, and safety constraints

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

Requires Docker and Docker Compose 2.20.3 or later.

```bash
git clone <repo-url> alexandria
cd alexandria
cp .env.example .env

# Set POSTGRES_PASSWORD, SESSION_SECRET, AI_ENCRYPTION_KEY, and
# SEED_ADMIN_PASSWORD to distinct random values before starting.
# Generate each value separately with: openssl rand -hex 32

# Pull the published images and start Postgres, Redis, backend, and frontend.
docker compose pull
docker compose up -d --no-build --wait
```

To build the backend and frontend images from the current checkout instead:

```bash
docker compose up -d --build --wait
```

On first startup, the backend automatically runs database migrations and seeds the default admin account and metadata fields. No manual seeding step is required.

To use hosted PostgreSQL instead of the bundled database, set `DATABASE_URL` and start Compose with the hosted-database override:

```bash
docker compose \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.hosted-db.yml \
  up -d
```

The override disables the local Postgres service and defaults the application pool to five connections. See [`docs/HOSTED_DATABASE.md`](docs/HOSTED_DATABASE.md) for generic provider configuration, verified TLS, and Supabase-specific guidance.

With the default local-database stack, services are available at:

- Frontend: http://localhost:80
- Backend API: http://localhost:3001
- Postgres: localhost:5433 (user: `alexandria`, password: your `.env` value, db: `alexandria`)

Default email: `admin@alexandria.local`. The initial password is the required `SEED_ADMIN_PASSWORD` value from `.env`.

To use a custom admin account, set `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, and `SEED_ADMIN_DISPLAY_NAME` in your environment before the first startup. The seed is idempotent — it uses `ON CONFLICT DO NOTHING`, so re-running it does not overwrite existing data.

Useful lifecycle commands:

```bash
docker compose logs -f
docker compose down          # Keep all named-volume data
docker compose down --volumes # Also delete Alexandria's database, queue, and stored files
```

Postgres, Redis, and managed model storage use the existing `docker_pgdata`, `docker_redisdata`, and `docker_storagedata` named volumes, so data survives container replacement and the switch from the previous explicit Compose-file command. `HTTP_PORT`, `BACKEND_PORT`, `POSTGRES_PORT`, and `REDIS_PORT` in `.env` control the host-side ports. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for upgrades, rollback constraints, configuration, backups, and production considerations.

### Published container images

GitHub Actions validates both production images on relevant pull requests and manual runs without publishing them. Pushes to `main` or a version tag first stage both multi-architecture (`linux/amd64` and `linux/arm64`) images, then promote public tags only after both builds succeed. Main publishes `latest`, `main`, and commit-specific `sha-...` tags. A tag such as `v1.2.0` publishes `1.2.0`, `1.2`, and a commit-specific tag; set `ALEXANDRIA_IMAGE_TAG` in `.env` to pin Compose to one of those versions.

- `ghcr.io/rukongai/alexandria-backend`
- `ghcr.io/rukongai/alexandria-frontend`

---

## Development Setup

Requires Node.js 20 or later.

```bash
npm install
npm run dev
```

`npm run dev` runs Turborepo's dev task across all packages. The backend uses `tsx watch` and the frontend uses Vite's dev server with hot reload. The frontend dev server proxies `/api/*` requests to `http://localhost:3000`.

To start Postgres and Redis, apply migrations and seed data, then run the development servers in one command, use `npm run dev:up`. Blank deployment secrets in `.env.example` receive local-development-only defaults in this script; the production Compose stack still requires explicit secrets.

### Companion tools

[`tools/telegram-importer`](tools/telegram-importer/README.md) is a standalone Python CLI for importing model media from a Telegram channel through a Telegram user account. It previews channel grouping, supports recognized split ZIP and RAR sets, and resumes interrupted Alexandria staged uploads from local SQLite state.

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

Note that this built-in default does not match the local development stack: Compose publishes Postgres on host port `5433` (`POSTGRES_PORT`), not `5432`. `npm run dev:up` exports a matching `DATABASE_URL` for you, so the mismatch only bites when running the backend or a migration directly — in that case set `DATABASE_URL` explicitly, for example `postgresql://alexandria:alexandria@localhost:5433/alexandria`.

Alexandria accepts a standard PostgreSQL connection URL, including provider TLS parameters. It runs migrations during every backend startup, so the configured database user must own the Alexandria schema and be allowed to create and alter its objects.

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
│   ├── docker-compose.hosted-db.yml
│   ├── Dockerfile.backend
│   └── Dockerfile.frontend
│
├── .github/workflows/
│   └── docker-build.yml    Container validation and GHCR publishing
├── compose.yaml            Root Docker Compose entry point
├── .dockerignore           Docker build-context exclusions
└── docs/                   Architecture, API reference, types, conventions
```

---

## Environment Variables

Backend variables can be set in the environment or a `.env` file. Defaults are listed where available.

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://alexandria:alexandria@localhost:5432/alexandria` | Postgres connection string |
| `DATABASE_POOL_MAX` | `10` (`5` in the hosted Compose override) | Maximum connections in each backend process's shared Postgres pool |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `STORAGE_BACKEND` | `local` | Managed storage provider: `local` or `s3` |
| `STORAGE_PATH` | `./data/storage` | Local managed-storage root; also the migration source when using S3 |
| `S3_ENDPOINT` | AWS SDK default | Custom S3-compatible endpoint URL; omit for AWS S3 |
| `S3_REGION` | `us-east-1` | S3 signing region |
| `S3_BUCKET` | — | Bucket name; required when `STORAGE_BACKEND=s3` |
| `S3_PREFIX` | empty | Optional object-key prefix, without a leading slash |
| `S3_FORCE_PATH_STYLE` | `false` | Use path-style instead of virtual-hosted-style bucket URLs |
| `ALEXANDRIA_MCP_USER_ID` | — | UUID of the account the local MCP server acts as; required by the MCP server |
| `ALEXANDRIA_MCP_LIBRARY_ID` | account's default library | Optional UUID of an owned library to scope the MCP server to |
| `ALEXANDRIA_MCP_DOWNLOAD_DIR` | — | Optional download root; required only to use `alexandria_download_model_files` |
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
| `SEED_ADMIN_PASSWORD` | _(required by Compose)_ | Initial admin account password |
| `SEED_ADMIN_DISPLAY_NAME` | `Admin` | Admin display name |

Docker Compose also reads these deployment variables:

| Variable | Default | Description |
|---|---|---|
| `ALEXANDRIA_IMAGE_TAG` | `latest` | Published backend and frontend image tag |
| `HTTP_PORT` | `80` | Frontend/Nginx host port |
| `BACKEND_PORT` | `3001` | Direct backend API host port |
| `POSTGRES_PORT` | `5433` | PostgreSQL host port |
| `REDIS_PORT` | `6379` | Redis host port |
| `POSTGRES_USER` | `alexandria` | PostgreSQL user; choose before first startup |
| `POSTGRES_PASSWORD` | _(required by Compose)_ | PostgreSQL password; choose before first startup |
| `POSTGRES_DB` | `alexandria` | PostgreSQL database name; choose before first startup |

S3 credentials are resolved through the AWS SDK default credential chain. For a simple deployment, set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and, for temporary credentials, `AWS_SESSION_TOKEN`. Workload roles, shared AWS configuration, and the other standard providers are also supported. The backend validates S3 bucket access before migrations or HTTP startup and exits if validation fails.

See [`docs/STORAGE.md`](docs/STORAGE.md) for provider configuration, MEGA S4 compatibility, private-object delivery, and local-to-S3 migration.

See [`docs/HOSTED_DATABASE.md`](docs/HOSTED_DATABASE.md) for hosted PostgreSQL deployment, TLS, pool sizing, and Supabase setup. A hosted database stores Alexandria's metadata and application state only. Model files and thumbnails remain in the configured storage backend; deployments that need to move between hosts should use S3-compatible storage. Alexandria currently assumes one backend process and does not support horizontal scaling.

---

## Testing

```bash
npm run test
```

Tests run with Vitest and live alongside source files. Integration tests require a running Postgres and Redis instance. Point `DATABASE_URL` at a local or Docker-hosted Postgres before running.

```bash
# Start only the infrastructure services for testing. Compose still resolves
# the backend environment, so provide a test-only encryption value.
AI_ENCRYPTION_KEY=test-only-not-for-production \
POSTGRES_PASSWORD=test-only-database-password \
SESSION_SECRET=test-only-session-secret \
SEED_ADMIN_PASSWORD=test-only-admin-password \
docker compose up -d postgres redis --wait
```

---

## Documentation

- `docs/ARCHITECTURE.md` — service boundaries, API design, and decision log
- `docs/API.md` — full API reference (64 endpoints)
- `docs/TYPES.md` — canonical type definitions
- `docs/CONVENTIONS.md` — naming, patterns, and coding standards
- `docs/DEPLOYMENT.md` — Docker Compose deployment, upgrades, and production considerations
- `docs/STORAGE.md` — local and S3-compatible storage configuration and migration
- `docs/MCP.md` — local stdio MCP tools, setup, and safety constraints
- `docs/HOSTED_DATABASE.md` — hosted PostgreSQL and Supabase deployment
- `docs/PROJECT-BRIEF.md` — project overview and rationale

---

## Roadmap

The following are planned but not yet implemented:

- **Multi-user support** — roles, per-user collections, shared libraries
- **Print job tracking** — link models to print history and notes
