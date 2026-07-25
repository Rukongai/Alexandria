# Deployment

Alexandria's supported deployment is the four-service Docker Compose stack defined in the root `compose.yaml`. It runs PostgreSQL 16, Redis 7 with append-only persistence, the Fastify backend, and the Nginx-served frontend. The older `docker compose -f docker/docker-compose.yml ...` form remains available as a compatibility wrapper, but new commands should use `docker compose` from the repository root.

## Start with published images

Install Docker with Compose 2.20.3 or later, then clone the repository so you have `compose.yaml` and the sample environment file. From the repository root:

```bash
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
```

Put the four distinct generated values in `.env` as `POSTGRES_PASSWORD`, `SESSION_SECRET`, `AI_ENCRYPTION_KEY`, and `SEED_ADMIN_PASSWORD`. `AI_ENCRYPTION_KEY` must remain stable: changing it makes saved AI-provider credentials unreadable. PostgreSQL initialization and Alexandria's conflict-safe seed do not overwrite existing credentials when these variables change later. For an existing installation, keep its current database and admin passwords unless you rotate them in PostgreSQL and Alexandria itself; changing only `.env` does not rotate stored credentials.

Pull and start the services:

```bash
docker compose pull
docker compose up -d --no-build --wait
docker compose ps
```

The frontend is available at `http://localhost` by default, and the backend health endpoint is `http://localhost:3001/health`. The backend, PostgreSQL, and Redis host ports bind to `127.0.0.1`; only the frontend port is exposed on all host interfaces. Change `HTTP_PORT` or `BACKEND_PORT` in `.env` when those ports are already in use. If GHCR requires authentication for the package, authenticate with `docker login ghcr.io` before pulling.

To build the application images from the current checkout instead of pulling them:

```bash
docker compose up -d --build --wait
```

The multi-stage Dockerfiles produce the same production targets used by GitHub Actions. The backend runs pending database migrations and the idempotent seed before it accepts traffic.

## Configuration

Compose reads `.env` from the repository root. The following settings control the stack itself:

| Variable | Default | Purpose |
|---|---|---|
| `ALEXANDRIA_IMAGE_TAG` | `latest` | Tag used for both published Alexandria images |
| `HTTP_PORT` | `80` | Frontend/Nginx host port |
| `BACKEND_PORT` | `3001` | Direct backend API host port |
| `POSTGRES_PORT` | `5433` | PostgreSQL host port |
| `REDIS_PORT` | `6379` | Redis host port |
| `POSTGRES_USER` | `alexandria` | Database user, also used in the backend connection string |
| `POSTGRES_PASSWORD` | none | Database password, also used in the backend connection string; required by Compose |
| `POSTGRES_DB` | `alexandria` | Database name |
| `SESSION_SECRET` | none | Cookie-signing secret; required by Compose |
| `AI_ENCRYPTION_KEY` | none | Separate stable secret for provider credentials; required by Compose |
| `AI_ALLOW_PRIVATE_PROVIDER_URLS` | `false` | Allow trusted loopback or LAN AI providers |
| `SEED_ADMIN_EMAIL` | `admin@alexandria.local` | Initial admin email |
| `SEED_ADMIN_PASSWORD` | none | Initial admin password; required by Compose |
| `SEED_ADMIN_DISPLAY_NAME` | `Admin` | Initial admin display name |

The root `.env.example` also contains `DATABASE_URL`, `REDIS_URL`, `STORAGE_PATH`, `PORT`, `HOST`, and `NODE_ENV` for running the backend directly during development. `npm run dev:up` derives a blank `DATABASE_URL` from the Postgres values and supplies local-development-only defaults for blank deployment secrets; Compose supplies its own container-network values for those settings.

Local storage is the default. Set `STORAGE_BACKEND=s3` and configure the `S3_*` and AWS credential variables to use private S3-compatible object storage. S3 deployments also keep a rebuildable local thumbnail cache by default; `S3_THUMBNAIL_CACHE_MAX_BYTES` controls its size and `S3_THUMBNAIL_CACHE_PATH` can move it to a dedicated persistent path. See [`STORAGE.md`](STORAGE.md) for the complete provider configuration and migration procedure.

## Images and releases

Compose pulls these images with the same value of `ALEXANDRIA_IMAGE_TAG`:

- `ghcr.io/rukongai/alexandria-backend`
- `ghcr.io/rukongai/alexandria-frontend`

Relevant pull requests and manual workflow runs build both `linux/amd64` images as validation but do not publish them. A push to `main` or a `v*.*.*` tag stages both `linux/amd64` and `linux/arm64` images with BuildKit provenance and an SBOM. A final job runs only after both builds succeed and promotes the paired public tags. Main publishes `latest`, `main`, and `sha-<full-commit>`; a tag such as `v1.2.3` publishes `1.2.3`, `1.2`, and `sha-<full-commit>`.

For a repeatable deployment, set `ALEXANDRIA_IMAGE_TAG` to a full version or commit tag rather than `latest` or `main`. Upgrade a pulled-image deployment with:

```bash
docker compose pull
docker compose up -d --no-build --wait
```

The backend applies database migrations during startup. Back up the database and managed storage before an upgrade. Changing `ALEXANDRIA_IMAGE_TAG` back to an earlier application image does not reverse a database migration, so verify schema compatibility before attempting an application rollback.

## Persistence and operations

The Compose project deliberately retains the legacy name `docker`, so existing installations continue to use these named volumes:

| Volume | Contents |
|---|---|
| `docker_pgdata` | PostgreSQL database |
| `docker_redisdata` | Redis append-only queue data |
| `docker_storagedata` | Locally managed objects; in S3 mode, migration/rollback sources and the rebuildable thumbnail cache |

Normal container replacement and `docker compose down` preserve these volumes. `docker compose down --volumes` deletes all three and should be treated as destructive. Back up PostgreSQL and `docker_storagedata` together so database file records remain consistent with stored objects. When using S3, include the bucket and prefix in the backup plan even though the local storage volume remains mounted for migration and rollback; the reserved local thumbnail-cache directory is rebuildable and does not need to be included in backups.

Useful operational commands are:

```bash
docker compose ps
docker compose logs -f backend
docker compose restart backend
docker compose down
```

All services have healthchecks. The backend waits for healthy Postgres and Redis containers, and the frontend waits for a healthy backend. A failed storage-access check or database migration stops backend startup; inspect `docker compose logs backend` for the cause.

## Production considerations

Terminate TLS in a reverse proxy in front of the frontend. The backend, PostgreSQL, and Redis host ports bind to loopback for administration and local development; do not widen those bindings without authentication and firewall controls. Keep the session secret, AI encryption key, database password, S3 credentials, and seeded admin password out of version control.

Pin an application image tag, monitor container health and disk use, and establish tested backups before upgrades. Alexandria's current architecture assumes a single backend instance; do not scale the backend horizontally without first providing shared rate limiting and reviewing queue, session, and local-storage behavior.
