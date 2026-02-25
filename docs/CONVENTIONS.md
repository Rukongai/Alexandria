# Alexandria — Coding Conventions

This document defines the patterns and standards that keep the Alexandria codebase consistent. Follow these conventions for all new code. When modifying existing code, bring it into compliance with these conventions if the change is small; flag it for a separate cleanup commit if it would be a large diff.

---

## Project Structure

```
alexandria/
├── apps/
│   ├── frontend/                # React + Vite + TypeScript
│   │   └── src/
│   │       ├── pages/           # Route-level page components
│   │       ├── components/      # Shared UI components
│   │       │   ├── ui/          # shadcn/ui primitives
│   │       │   ├── models/      # Model-specific components
│   │       │   ├── collections/ # Collection-specific components
│   │       │   └── metadata/    # Metadata field rendering
│   │       ├── hooks/           # Custom React hooks
│   │       ├── api/             # API client — one file per domain
│   │       │   ├── models.ts
│   │       │   ├── collections.ts
│   │       │   ├── metadata.ts
│   │       │   └── auth.ts
│   │       ├── types/           # Frontend-only types (rare)
│   │       ├── lib/             # Utilities
│   │       └── App.tsx
│   │
│   └── backend/                 # Fastify + TypeScript
│       └── src/
│           ├── routes/          # Fastify route definitions (thin)
│           │   ├── models.ts
│           │   ├── collections.ts
│           │   ├── metadata.ts
│           │   ├── auth.ts
│           │   └── bulk.ts
│           ├── services/        # Business logic — one file per service
│           │   ├── ingestion.service.ts
│           │   ├── file-processing.service.ts
│           │   ├── storage.service.ts
│           │   ├── thumbnail.service.ts
│           │   ├── search.service.ts
│           │   ├── model.service.ts
│           │   ├── metadata.service.ts
│           │   ├── collection.service.ts
│           │   ├── auth.service.ts
│           │   ├── job.service.ts
│           │   └── presenter.service.ts
│           ├── workers/         # BullMQ job handlers
│           │   ├── ingestion.worker.ts
│           │   └── thumbnail.worker.ts
│           ├── db/
│           │   ├── schema/      # Drizzle schema definitions
│           │   │   ├── user.ts
│           │   │   ├── model.ts
│           │   │   ├── model-file.ts
│           │   │   ├── thumbnail.ts
│           │   │   ├── metadata.ts
│           │   │   ├── tag.ts
│           │   │   ├── collection.ts
│           │   │   └── index.ts
│           │   └── migrations/
│           ├── config/          # Environment and app config
│           │   └── index.ts
│           ├── middleware/      # Auth, validation, error handling
│           ├── utils/           # Pure utility functions (no domain logic)
│           └── app.ts           # Fastify app setup
│
├── packages/
│   └── shared/                  # Shared between frontend and backend
│       └── src/
│           ├── types/           # Canonical type definitions
│           │   ├── model.ts
│           │   ├── metadata.ts
│           │   ├── collection.ts
│           │   ├── auth.ts
│           │   ├── api.ts       # Envelope, pagination, error types
│           │   └── index.ts
│           ├── constants/       # Shared enums, defaults
│           ├── validation/      # Zod schemas for request validation
│           └── index.ts
│
├── docker/
│   ├── Dockerfile.frontend
│   ├── Dockerfile.backend
│   └── docker-compose.yml
│
├── docs/                        # Project documentation
│   ├── ARCHITECTURE.md
│   ├── TYPES.md
│   ├── CONVENTIONS.md
│   ├── AGENTS.md
│   ├── PLAN.md
│   └── PROJECT-BRIEF.md
│
├── package.json                 # Workspace root
├── turbo.json
└── README.md
```

---

## Naming Conventions

| What | Pattern | Examples |
|------|---------|---------|
| Files | kebab-case | `model.service.ts`, `file-processing.service.ts`, `model-file.ts` |
| Service files | `<name>.service.ts` | `metadata.service.ts`, `presenter.service.ts` |
| Worker files | `<name>.worker.ts` | `ingestion.worker.ts` |
| Schema files | `<entity>.ts` | `model.ts`, `model-file.ts`, `metadata.ts` |
| Route files | `<domain>.ts` | `models.ts`, `collections.ts`, `auth.ts` |
| Types/Interfaces | PascalCase | `ModelCard`, `MetadataFieldDefinition`, `ApiResponse<T>` |
| Functions/Variables | camelCase | `getModelById`, `buildFileTree`, `thumbnailUrl` |
| Constants | UPPER_SNAKE_CASE | `DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE`, `SUPPORTED_IMAGE_FORMATS` |
| Database tables | snake_case | `model_files`, `metadata_field_definitions`, `model_tags` |
| Database columns | snake_case | `relative_path`, `field_definition_id`, `created_at` |
| API routes | kebab-case segments | `/metadata/fields`, `/models/:id/files` |
| Environment variables | UPPER_SNAKE_CASE | `DATABASE_URL`, `STORAGE_PATH`, `REDIS_URL` |

### Service Method Naming

Service methods follow a verb-noun pattern that communicates intent:

- **get**: retrieve a single entity — `getModelById`, `getFieldDefinition`
- **list**: retrieve multiple entities — `listCollections`, `listFieldValues`
- **create**: create a new entity — `createModel`, `createCollection`
- **update**: modify an existing entity — `updateModel`, `updateFieldDefinition`
- **delete**: remove an entity — `deleteModel`, `deleteCollection`
- **build**: assemble a response shape (PresenterService) — `buildModelCard`, `buildFileTree`
- **assign/remove**: manage relationships — `assignMetadata`, `removeModelFromCollection`
- **process**: execute a pipeline step — `processArchive`, `processFolder`

---

## Route Handler Pattern

Route handlers are thin. They validate input, call services, and return formatted responses. They do not contain business logic.

```typescript
// Good — thin handler, delegates immediately
app.get('/models/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const model = await modelService.getModelById(id);
  const response = presenterService.buildModelDetail(model);
  return reply.send({ data: response, meta: null, errors: null });
});

// Bad — business logic in handler
app.get('/models/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const model = await db.select().from(models).where(eq(models.id, id));
  const files = await db.select().from(modelFiles).where(eq(modelFiles.modelId, id));
  const tags = await db.select()...
  // Don't do this. This belongs in a service.
});
```

---

## Service Pattern

Each service is a class or module that encapsulates a coherent set of operations. Services receive their dependencies through constructor injection or module-level initialization.

Services:
- Accept domain types as input, return domain types as output.
- Throw `AppError` instances for expected failures.
- Never catch errors from other services unless they have a meaningful recovery action. Let errors propagate to the route error handler.
- Never format HTTP responses. They have no knowledge of HTTP status codes, headers, or the response envelope.
- Never call other services' internal/private methods. Only use the public interface.

```typescript
// Good — service returns domain data, throws typed errors
class ModelService {
  async getModelById(id: string): Promise<Model> {
    const model = await this.db.select()...
    if (!model) {
      throw new AppError('NOT_FOUND', 404, `Model ${id} not found`);
    }
    return model;
  }
}

// Bad — service formats HTTP response
class ModelService {
  async getModelById(id: string) {
    const model = await this.db.select()...
    return { statusCode: 200, body: { data: model } }; // Don't do this
  }
}
```

---

## Error Handling

### AppError

All expected errors use the `AppError` class:

```typescript
class AppError extends Error {
  constructor(
    public code: string,
    public statusCode: number,
    message: string,
    public field?: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}
```

### Error Codes

Standard codes are constants, not magic strings:

```typescript
const ErrorCodes = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  CONFLICT: 'CONFLICT',
  PROCESSING_FAILED: 'PROCESSING_FAILED',
  STORAGE_ERROR: 'STORAGE_ERROR',
  IMPORT_FAILED: 'IMPORT_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;
```

### Error Handler

The Fastify error handler catches `AppError` instances and formats them:

```typescript
// AppError → structured envelope response
{ data: null, meta: null, errors: [{ code, field, message }] }

// Unexpected errors → logged with full context, generic 500 to client
{ data: null, meta: null, errors: [{ code: 'INTERNAL_ERROR', field: null, message: 'An unexpected error occurred' }] }
```

Unexpected errors log the full stack trace, request context, and any available identifiers (model ID, job ID, etc.). The client never sees internal error details.

---

## Validation

Zod schemas live in `packages/shared/src/validation/`. They define the shape and constraints of API request bodies and query parameters.

- Validation runs in Fastify route handlers via middleware, before the request reaches a service.
- Services trust that their input has been validated. They do not re-validate.
- The same Zod schemas are used for frontend form validation and backend request validation.
- Validation errors are caught by middleware and returned as `VALIDATION_ERROR` with the relevant field name.

---

## Logging

Structured JSON logging via Fastify's built-in Pino logger.

### Log Levels

- **error**: Failures requiring attention — unhandled exceptions, storage failures, job crashes.
- **warn**: Recoverable issues — hardlink fallback to copy, retry attempts, missing optional data.
- **info**: Operational events — job started, job completed, model created, import finished, user authenticated.
- **debug**: Development-time detail — query parameters, file classification results, metadata extraction details.

### Context Fields

Every log entry includes:

- `service`: which service produced the log (e.g., `IngestionService`, `StorageService`)
- `requestId`: for HTTP request-scoped logs (auto-generated by Fastify)
- `jobId`: for job-scoped logs (present in worker contexts)
- `modelId`: when relevant to a specific model operation

```typescript
// Good
logger.info({ service: 'IngestionService', modelId, jobId }, 'Processing started');

// Bad — unstructured string logging
logger.info(`Processing started for model ${modelId} in job ${jobId}`);
```

---

## Database Conventions

### Schema Definitions

- All tables have `id` as UUID primary key, generated by the database.
- All entities have `createdAt` with a database-level default of `now()`.
- Entities that can be updated have `updatedAt` with a trigger or application-level update.
- Foreign keys are always defined with explicit cascade behavior. Default: `ON DELETE CASCADE` for child records (ModelFile when Model is deleted), `ON DELETE SET NULL` for optional references (Collection.parentCollectionId).
- Join tables have composite primary keys on both foreign keys.
- Indexes: created explicitly for foreign keys, slug fields, and any column used in WHERE clauses or JOINs. The schema file documents why each index exists.

### Migrations

Migration SQL files live in `apps/backend/src/db/migrations/`. **Every new migration file must also be registered in `apps/backend/src/db/migrations/meta/_journal.json`** — Drizzle's auto-migration runner reads only this journal to determine which migrations are pending. A SQL file that exists on disk but is not in the journal will never be applied.

When adding a migration:
1. Create the SQL file (e.g., `0006_my_change.sql`)
2. Add the corresponding entry to `_journal.json` with the correct `idx`, `tag` (filename without `.sql`), and a `when` timestamp

Migrations are forward-only. No down migrations in this project.

### Slug Generation

Slugs are generated from names using a consistent utility function:
- Lowercase, trim whitespace
- Replace spaces and special characters with hyphens
- Remove consecutive hyphens
- Append a short random suffix to guarantee uniqueness (e.g., `dragon-bust-a3f2`)

---

## Storage Conventions

### Path Structure

Files in managed storage follow this path pattern:
```
<storage_root>/models/<model_id>/<relative_path>
<storage_root>/thumbnails/<model_id>/<thumbnail_id>.webp
```

Thumbnail sizes are defined as constants:
```typescript
const THUMBNAIL_SIZES = {
  grid: { width: 400, height: 400 },
  detail: { width: 800, height: 800 },
} as const;
```

These are target sizes passed to `sharp`, which uses `fit: inside`. Because `fit: inside` never upscales, a source image smaller than the target is written at its original dimensions. A 300×300 source produces a 300×300 grid thumbnail, not a 400×400 one. As a result, the `width` and `height` columns on a `Thumbnail` record reflect the actual output dimensions and cannot be used to reliably identify whether a thumbnail is `grid` or `detail` size. Use the `storagePath` suffix instead: paths ending in `_grid.webp` are grid thumbnails; paths ending in `_detail.webp` are detail thumbnails.

### File Hashing

SHA-256 hash is computed on every file during ingestion and stored on the ModelFile record. Hashing happens as part of the file read — the file is streamed through a hash computation, not read twice.

---

## Frontend Conventions

### API Client

One file per domain in `src/api/`. Each file exports typed functions that call the backend API and return properly typed responses.

```typescript
// src/api/models.ts
export async function getModels(params: ModelSearchParams): Promise<ApiResponse<ModelCard[]>> {
  // fetch, parse, return typed response
}
```

The API client handles:
- Base URL configuration
- Session cookie inclusion
- Envelope unwrapping (optional — may expose raw envelope for pagination meta access)
- Error transformation

### Component Organization

- Page components live in `src/pages/` and correspond to routes.
- Shared components live in `src/components/` organized by domain.
- shadcn/ui primitives live in `src/components/ui/` and are used as-is or minimally extended.
- Components receive data as props. They do not call services directly — they call hooks or receive data from page components.

### State Management

Use React's built-in state management (useState, useReducer, useContext) unless complexity warrants a dedicated solution. Avoid premature adoption of external state libraries.

API data caching and synchronization: use React Query (TanStack Query) for server state management. This handles caching, refetching, pagination, and optimistic updates.

### Theming

Dark mode is implemented via a `dark` class on `<html>`. `ThemeProvider` (`src/hooks/use-theme.ts`) manages the active theme (`'light' | 'dark' | 'system'`), persists it to `localStorage`, and applies or removes the `dark` class on `document.documentElement`. When theme is `'system'`, it follows `prefers-color-scheme`.

Color tokens are defined as CSS custom properties in `src/index.css`. shadcn/ui components consume these tokens automatically. Hardcoded Tailwind color utilities (e.g., `bg-gray-800`) must use explicit `dark:` variants — they do not pick up the CSS variable system.

`ThemeProvider` must wrap the app root in `main.tsx` for `useTheme` to be available anywhere in the tree.

---

## Testing Conventions

### Backend Tests

- **Unit tests** for services with complex logic (PatternParser, metadata storage routing, file tree building, slug generation).
- **Integration tests** for API endpoints — validate that the correct request produces the correct envelope response.
- Test files live alongside the code they test: `metadata.service.test.ts` next to `metadata.service.ts`.

### Frontend Tests

- **Component tests** for complex interactive components (search/filter bar, metadata editor, file tree viewer).
- Page-level tests are deferred unless there's complex client-side logic beyond data fetching and display.

### Test Naming

Test descriptions follow the pattern: `should <expected behavior> when <condition>`.

```typescript
// Good
it('should return NOT_FOUND error when model ID does not exist', ...);
it('should route tag metadata to optimized storage', ...);

// Bad
it('works correctly', ...);
it('test metadata', ...);
```

---

## Git Conventions

### Commit Messages

Format: `<type>(<scope>): <description>`

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `build`

Scope: the service, component, or area affected.

Examples:
```
feat(ingestion): implement zip upload pipeline
fix(metadata): correct tag storage routing for multi_enum type
refactor(presenter): extract file tree builder into utility
test(search): add integration tests for metadata filtering
docs(architecture): update decision log with D13
chore(docker): add Redis health check to compose file
```

### Branching

Implementation phases map to branches. Work happens on phase branches and merges to `main` at phase milestones after review.
