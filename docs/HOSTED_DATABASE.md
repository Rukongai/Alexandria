# Hosted PostgreSQL

Alexandria can use any compatible hosted PostgreSQL service through `DATABASE_URL`. The database contains users, libraries, metadata, file indexes, job-related application state, and other relational data. It does not contain model files or thumbnails. Those remain in the configured local or S3-compatible storage backend.

For a deployment that may move between hosts, configure S3-compatible storage as described in [`STORAGE.md`](STORAGE.md). A hosted database alone does not make files in a local Docker volume remotely accessible.

Hosted PostgreSQL and S3 improve deployment portability, but they do not make Alexandria horizontally scalable. The current architecture assumes one backend process because chunked-upload state and some rate limits are process-local. Multiple backend replicas require shared upload coordination, shared rate limiting, and coordinated migrations; that work is deferred.

## Connection requirements

Create a dedicated database and database user for Alexandria rather than sharing an application schema with unrelated software. The user must be able to create and alter schema objects because the backend runs Drizzle migrations before accepting traffic on every startup.

Set the connection and pool size in `.env`:

```dotenv
DATABASE_URL=postgresql://alexandria:encoded-password@db.example.com:5432/alexandria?sslmode=verify-full&sslrootcert=/run/secrets/provider-ca.crt
DATABASE_POOL_MAX=5
```

Percent-encode reserved characters in usernames and passwords. `sslrootcert` is a path inside the backend container, so mount the provider's CA/root certificate there as a read-only file or inject it with the deployment platform's secret mechanism. For example, an operator-owned Compose overlay can add:

```yaml
services:
  backend:
    volumes:
      - ./certs/provider-ca.crt:/run/secrets/provider-ca.crt:ro
```

Use `sslmode=verify-full` in production. It encrypts the connection, validates the certificate chain against the supplied provider CA/root certificate, and verifies that the certificate matches the database hostname. `sslmode=require` requires encryption under standard PostgreSQL semantics but does not verify server identity; it is useful only as a compatibility fallback, not as the recommended production configuration. Alexandria passes `sslmode`, `sslrootcert`, `sslcert`, and `sslkey` from `DATABASE_URL` to `node-postgres` without replacing them with application-level TLS options.

`DATABASE_POOL_MAX` is the maximum size of the shared pool in the backend process. The application default and local Compose default are 10. The hosted Compose override defaults to 5 because small provider plans often have tighter connection limits. Leave capacity for startup migrations, provider administration, backups, and other database clients. Alexandria currently supports one backend process; if horizontal scaling is implemented later, each replica will have its own pool and the total connection budget must account for all of them.

## Docker Compose

Set `DATABASE_URL` in the repository `.env`, then apply both Compose files:

```bash
docker compose \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.hosted-db.yml \
  up -d
```

The override places the bundled `postgres` service behind the inactive `local-database` profile and makes the backend's dependency on it optional. Redis still runs from the base Compose file. The backend exits if it cannot connect or apply migrations to the hosted database.

Back up the hosted database using the provider's supported PostgreSQL backup process. Keep database backups and object-storage backups together: neither one is a complete Alexandria backup by itself.

## Supabase

Use a dedicated Supabase project for Alexandria. Alexandria treats it as PostgreSQL only; it does not use Supabase Auth, client libraries, REST, or GraphQL.

Copy a connection string from the project's **Connect** panel. Supabase recommends its direct endpoint for long-lived backends such as persistent containers. The direct endpoint uses IPv6 unless the project has the IPv4 add-on. If the Alexandria host cannot reach IPv6, use the shared Supavisor **session mode** endpoint on port 5432 instead. Copy the exact host and username shown by the dashboard rather than constructing them manually. See Supabase's [connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres).

Do not use Supavisor transaction mode on port 6543. It is intended for short-lived serverless or edge clients, does not support all session features, and conflicts with Alexandria's startup migrations and persistent application-side pool. Direct and session-mode connections preserve the session behavior Alexandria expects.

Download the project's server root certificate from the connection settings, mount it into the backend, and add `sslmode=verify-full&sslrootcert=/run/secrets/supabase-ca.crt` to the connection URL. Supabase documents the certificate requirement in its [SSL enforcement guide](https://supabase.com/docs/guides/platform/ssl-enforcement).

Disable the Supabase Data API for this project when it is not otherwise needed. Alexandria owns its schema and authentication boundary and does not create Row Level Security policies for browser access through Supabase roles. If the Data API must remain enabled, restrict its exposed schemas and grants and add complete RLS policies before allowing any Supabase client access. Supabase's [API security guide](https://supabase.com/docs/guides/api/securing-your-api) explains how to disable the API and limit exposed database objects.
