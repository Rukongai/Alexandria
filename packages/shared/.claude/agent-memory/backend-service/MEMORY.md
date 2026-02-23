# Backend Service Agent Memory

## Project Layout

- Backend: `apps/backend/src/`
- Shared package: `packages/shared/src/` — import as `@alexandria/shared`
- DB module (Drizzle + pg): `apps/backend/src/db/index.ts` — exports `db`, `pool`
- DB schema: `apps/backend/src/db/schema/` — each entity has its own file
- DB migrate script: `apps/backend/src/db/migrate.ts` — runs as standalone script, not importable. Use `drizzle-orm/node-postgres/migrator` directly in server.ts.

## Key Conventions

- All files use ESM (`import`/`export`, `.js` extensions in imports resolve to `.ts` source via tsx)
- `moduleResolution: bundler` in tsconfig — `.js` extensions on imports are correct
- Envelope format: `{ data, meta, errors }` on every response — no exceptions
- Services throw `AppError`, never format HTTP responses
- Route handlers: validate → call service → return envelope (5-15 lines)
- Structured logging: always include `{ service: 'ServiceName', ... }` in log calls

## Auth Pattern

- Cookie name: `alexandria_session`
- Cookie is signed via `@fastify/cookie` (secret from `config.sessionSecret`)
- `requireAuth` hook: reads cookie, calls `unsignCookie`, passes raw user ID to `authService.validateSession`
- `AuthService` is attached to the Fastify instance as `app.authService` — middleware resolves it via `request.server`
- `UserProfile` (without `passwordHash`) is what routes return — never return `User` directly

## Shared Package Exports

- Types: `User`, `UserProfile`, `UserRole`, `UpdateProfileRequest`, `LoginRequest` — from `@alexandria/shared`
- Constants: `ErrorCodes` — from `@alexandria/shared`
- Validation schemas: `loginSchema`, `updateProfileSchema` — from `@alexandria/shared`

## StorageService

- All paths are relative to `config.storagePath`
- `delete` is idempotent — ENOENT is silently ignored
- Handles both Buffer and stream inputs in `store()`
- Exported as both the class `StorageService` and a default singleton `storageService`

## AppError Factories (utils/errors.ts)

`notFound`, `unauthorized`, `forbidden`, `conflict`, `validationError`, `storageError`, `internalError`

## Drizzle Schema Note

- `updatedAt` column is typed as `Date` in the Drizzle schema — pass `new Date()` when setting it in update patches
- User schema Drizzle type: `users.$inferInsert` for insert, `users.$inferSelect` for select
