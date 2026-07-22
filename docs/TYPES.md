# Alexandria — Type Definitions

This document defines the canonical type hierarchy for Alexandria. All types have one definition, here. Services, routes, and frontend code reference these types — they do not redefine them. Types live in `packages/shared/src/types/` and are imported by both apps.

When a new type is needed, it is added here first, then implemented in the shared package. If a type needs to change, this document is updated first.

---

## Conventions

- All entity IDs are UUID v4 strings.
- All timestamps are ISO 8601 strings in API responses, stored as `timestamp with time zone` in Postgres.
- Nullable fields are explicitly marked. If not marked, the field is required.
- The `Summary/Detail` pattern is used throughout: lightweight summary types for embedding in other responses, fuller detail types when the entity is the primary resource.

---

## Database Entities

These map directly to Drizzle schema definitions and database tables.

### Library

```typescript
interface Library {
  id: string;
  name: string;
  slug: string;       // globally unique; URL-safe
  userId: string;
  isDefault: boolean; // exactly one default per user; enforced by DB partial unique index
  color: string;      // palette-accent badge: amber | teal | sage | plum | slate (P5)
  createdAt: string;
  updatedAt: string;
}

// P5 — returned by GET /libraries; powers the All-Libraries cards and switcher
interface LibrarySummary extends Library {
  modelCount: number;
  collectionCount: number;
}

interface CreateLibraryRequest { name: string; color?: LibraryColor }
interface UpdateLibraryRequest { name?: string; color?: LibraryColor }
// LibraryColor = 'amber' | 'teal' | 'sage' | 'plum' | 'slate' (LIBRARY_COLORS)
```

The shared types are defined in `packages/shared/src/types/library.ts` (validation in `packages/shared/src/validation/library.ts`). The database schema is in `apps/backend/src/db/schema/library.ts`. See the Architecture Reference for the `requireLibrary` preHandler, the `X-Library-Id` header, and library-scoping rules.

### User

```typescript
interface User {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

type UserRole = 'admin' | 'user';
```

### Model

```typescript
interface Model {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  userId: string;
  libraryId: string;             // NOT NULL; every model belongs to a library (P1+)
  sourceType: ModelSourceType;
  status: ModelStatus;
  originalFilename: string | null;
  totalSizeBytes: number;
  fileCount: number;
  fileHash: string | null;
  previewImageFileId: string | null; // user-selected cover image; null = first-image fallback
  createdAt: string;
  updatedAt: string;
}

type ModelSourceType = 'zip_upload' | 'archive_upload' | 'folder_import' | 'manual';
type ModelStatus = 'processing' | 'ready' | 'error';
```

### ModelFile

```typescript
interface ModelFile {
  id: string;
  modelId: string;
  filename: string;
  relativePath: string;
  fileType: FileType;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  hash: string;
  createdAt: string;
}

type FileType = 'stl' | 'image' | 'document' | 'other';
```

### Thumbnail

```typescript
interface Thumbnail {
  id: string;
  sourceFileId: string;
  storagePath: string; // suffix _grid.webp or _detail.webp identifies size variant
  width: number;       // actual output dimensions, not target size (sharp fit:inside never upscales)
  height: number;      // actual output dimensions, not target size
  format: string;      // default: 'webp'
  createdAt: string;
}
```

`width` and `height` reflect the dimensions of the generated file, which may be smaller than the target size when the source image is smaller than the target. To determine whether a thumbnail is a grid or detail variant, read the `storagePath` suffix: paths ending in `_grid.webp` are grid thumbnails (target 400×400) and paths ending in `_detail.webp` are detail thumbnails (target 800×800).

### MetadataFieldDefinition

```typescript
interface MetadataFieldDefinition {
  id: string;
  name: string;
  slug: string;
  type: MetadataFieldType;
  isDefault: boolean;
  isFilterable: boolean;
  isBrowsable: boolean;
  config: MetadataFieldConfig | null;
  sortOrder: number;
  createdAt: string;
}

type MetadataFieldType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'url'
  | 'enum'
  | 'multi_enum';

interface MetadataFieldConfig {
  enumOptions?: string[];        // for enum and multi_enum types
  validationPattern?: string;    // optional regex for text fields
  displayHint?: string;          // optional hint for frontend rendering
}
```

### ModelMetadata (generic storage)

```typescript
interface ModelMetadata {
  id: string;
  modelId: string;
  fieldDefinitionId: string;
  value: string; // stored as text, parsed by type
}
```

### Tag (optimized storage — internal to MetadataService)

```typescript
interface Tag {
  id: string;
  name: string;
  slug: string;
}
```

Join table `model_tags`: `{ modelId: string, tagId: string }`

### Collection

```typescript
interface Collection {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  userId: string;
  libraryId: string;             // NOT NULL; every collection belongs to a library (P1+)
  parentCollectionId: string | null;
  createdAt: string;
  updatedAt: string;
}
```

Join table `collection_models`: `{ collectionId: string, modelId: string }`

### SmartCollection

A dynamic, rule-based collection. The `definition` field is the sole server state — results are derived on read by compiling the tree into SQL. The database schema is in `apps/backend/src/db/schema/smart-collection.ts` and migration `0009_add_smart_collections.sql`. Shared types are in `packages/shared/src/types/smart-collection.ts`.

```typescript
interface SmartCollection {
  id: string;
  name: string;
  slug: string;       // globally unique; URL-safe
  description: string | null;
  definition: RuleNode; // the rule tree; see below
  userId: string;
  createdAt: string;
  updatedAt: string;
}
```

There is no membership join table and no parent/child nesting.

#### Rule Tree Types

A rule tree is a `RuleNode` — either a leaf condition or a group combining children with AND or OR.

```typescript
// A leaf: one condition targeting one field.
interface RuleCondition {
  kind: 'condition';
  field: RuleFieldRef;
  operator: RuleOperator;
  value: string | null; // null only for exists/notExists operators
}

// A branch: combine children with AND or OR.
interface RuleGroup {
  kind: 'group';
  op: 'and' | 'or';
  children: RuleNode[];
}

type RuleNode = RuleGroup | RuleCondition;
```

`RuleFieldRef` identifies the field a condition targets — either a named built-in dimension or a user-defined metadata field by slug:

```typescript
type RuleFieldRef =
  | { source: 'builtin'; field: BuiltinRuleField }
  | { source: 'metadata'; slug: string };

type BuiltinRuleField =
  | 'name'         // full-text search / exact match on model name
  | 'description'  // ILIKE substring match on description
  | 'status'       // models.status column
  | 'fileType'     // EXISTS in model_files for the given file_type
  | 'collection'   // membership in a collection (by UUID value)
  | 'tag';         // tag membership (by name, case-insensitive)
```

`RuleOperator` is the set of operators available in v1. All are text-safe — numeric and date comparison operators are deferred because metadata values are stored as untyped text.

```typescript
type RuleOperator =
  | 'contains'         // full-text / ILIKE substring
  | 'equals'           // exact, case-insensitive
  | 'notEquals'
  | 'is'               // enum / boolean exact match
  | 'isNot'
  | 'has'              // file type present (EXISTS)
  | 'notHas'
  | 'hasTag'           // tag membership
  | 'notHasTag'
  | 'inCollection'     // collection membership
  | 'notInCollection'
  | 'exists'           // metadata field has any value (no value required)
  | 'notExists';
```

Legal operator combinations — which operators are valid for which fields — are defined in `LEGAL_OPERATORS_BY_BUILTIN` and `LEGAL_OPERATORS_BY_METADATA_TYPE` in `packages/shared/src/types/smart-collection.ts`. The shared validator enforces built-in legality; metadata legality is checked server-side once the field definition is resolved.

Tree complexity bounds (enforced by the shared Zod schema and re-checked server-side):

| Bound | Value | Constant |
|-------|-------|----------|
| Maximum group nesting depth | 3 | `SMART_COLLECTION_MAX_DEPTH` |
| Maximum total nodes | 50 | `SMART_COLLECTION_MAX_NODES` |
| Maximum children per group | 20 | `SMART_COLLECTION_MAX_CHILDREN` |

#### Smart Collection Response Types

```typescript
// Lightweight; used in the list response
interface SmartCollectionSummary {
  id: string;
  name: string;
  slug: string;
}

// Full detail; returned by create, update, and GET /:id
interface SmartCollectionDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  definition: RuleNode;
  modelCount: number; // derived live by executing the rule tree
  createdAt: string;
  updatedAt: string;
}
```

`modelCount` in `SmartCollectionDetail` is computed by running the compiled rule tree through `SearchService.searchModels` at response time. The list endpoint (`GET /smart-collections`) returns `SmartCollection` (no count) to avoid N+1 queries.

### ImportSession

A staged archive upload awaiting review and commit. Created by `POST /models/upload`, the single-file chunked complete endpoint, or multipart complete; destroyed by commit or discard. One session always creates one model, even when its scan input contains several independent archives or a split ZIP set. The database schema is in `apps/backend/src/db/schema/import-session.ts` and migration `0008_add_import_sessions.sql`.

```typescript
interface ImportSession {
  id: string;
  userId: string;
  libraryId: string;
  originalFilename: string;
  status: ImportSessionStatus;
  detected: DetectedImportMetadata | null; // null while scanning
  manifest: unknown | null;                // internal file manifest; not exposed in API responses
  stagingPath: string | null;              // server-side path to extracted files; not exposed in API responses
  modelId: string | null;                  // set during commit; FK → models (set null on model delete)
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;                  // sessions expire after 24 hours if not committed
}

type ImportSessionStatus =
  | 'scanning'          // scan job running
  | 'ready_for_review'  // scan complete; waiting for user to commit or discard
  | 'committing'        // commit job running
  | 'committed'         // model created; session complete (not returned by list endpoint)
  | 'error';            // scan or commit failed
```

---

## API Response Types

These are what PresenterService builds and the API returns. They are shaped for frontend consumption.

### Envelope

```typescript
interface ApiResponse<T> {
  data: T;
  meta: ResponseMeta | null;
  errors: ApiError[] | null;
}

interface ResponseMeta {
  total: number;
  cursor: string | null; // null on last page
  pageSize: number;
}

interface ApiError {
  code: string;
  field: string | null;
  message: string;
}
```

### Model Response Types

```typescript
// Used in grid/list views — compact, optimized for rendering cards
interface ModelCard {
  id: string;
  name: string;
  slug: string;
  thumbnailUrl: string | null;
  metadata: MetadataValue[];
  fileCount: number;
  totalSizeBytes: number;
  status: ModelStatus;
  createdAt: string;
}

// Used on model detail page — full information
interface ModelDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  thumbnailUrl: string | null;
  previewImageFileId: string | null; // user-selected cover image; null = first-image fallback
  metadata: MetadataValue[];
  sourceType: ModelSourceType;
  originalFilename: string | null;
  fileCount: number;
  totalSizeBytes: number;
  status: ModelStatus;
  collections: CollectionSummary[];
  images: ImageFile[];
  createdAt: string;
  updatedAt: string;
}

// Image entry for the gallery on model detail
interface ImageFile {
  id: string;
  filename: string;
  thumbnailUrl: string;
  originalUrl: string;
}
```

### File Tree Types

```typescript
// Nested tree structure built by PresenterService from flat relativePath values
interface FileTreeNode {
  name: string;
  type: 'file' | 'directory';
  fileType?: FileType;       // present for files only
  sizeBytes?: number;        // present for files only
  id?: string;               // present for files only (ModelFile.id)
  children?: FileTreeNode[]; // present for directories only
}
```

### Metadata Response Types

```typescript
// Individual metadata value on a model
interface MetadataValue {
  fieldSlug: string;
  fieldName: string;
  type: MetadataFieldType;
  value: string | string[]; // string[] for multi_enum (tags)
  displayValue: string;     // human-readable formatted value
}

// Summary for embedding in other responses
interface MetadataFieldSummary {
  id: string;
  name: string;
  slug: string;
  type: MetadataFieldType;
}

// Full detail for metadata field management
interface MetadataFieldDetail {
  id: string;
  name: string;
  slug: string;
  type: MetadataFieldType;
  isDefault: boolean;
  isFilterable: boolean;
  isBrowsable: boolean;
  config: MetadataFieldConfig | null;
  sortOrder: number;
}

// Used in GET /metadata/fields/:slug/values
interface MetadataFieldValue {
  value: string;
  modelCount: number;
}
```

### Collection Response Types

```typescript
interface CollectionSummary {
  id: string;
  name: string;
  slug: string;
}

interface CollectionDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  parentCollectionId: string | null;
  children: CollectionSummary[];
  modelCount: number;
  createdAt: string;
  updatedAt: string;
}
```

### Auth Response Types

```typescript
interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
}
```

### Job/Status Types

```typescript
interface JobStatus {
  modelId: string;
  status: ModelStatus;
  progress: number | null;   // 0-100 percentage, null if not trackable
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}
```

### Import Types

```typescript
interface ImportConfig {
  sourcePath: string;
  pattern: string; // e.g., '{Collection}/{metadata.Artist}/{model}'
  strategy: ImportStrategy;
  deleteAfterUpload?: boolean; // S3 only
}

type ImportStrategy = 'hardlink' | 'copy' | 'move';

// Parsed representation of a hierarchy pattern (internal to FileProcessingService)
interface ParsedPatternSegment {
  type: 'collection' | 'metadata' | 'model';
  metadataSlug?: string; // present when type is 'metadata'
}

interface ImportJob {
  modelId: string;
  status: ModelStatus;
  strategy: ImportStrategy;
  totalFiles: number;
  processedFiles: number;
  failedFiles: number;
  phase: ImportPhase;
  startedAt: string;
  completedAt: string | null;
}

type ImportPhase = 'scanning' | 'importing' | 'processing' | 'complete' | 'error';
```

### Staged Upload Types

These types support the scan → review → commit ingestion workflow introduced in P3. All are defined in `packages/shared/src/types/upload.ts`.

```typescript
// API response from POST /models/upload and POST /models/upload/:uploadId/complete
interface ScanUploadResponse {
  sessionId: string;
}

// Explicit behavior for a multipart archive group.
type MultipartArchiveMode = 'combine' | 'split';

// POST /models/upload/multipart/complete
interface CompleteMultipartUploadRequest {
  uploadIds: string[];           // 2–100 unique chunked upload session IDs
  mode: MultipartArchiveMode;
}

// A node in the folder-structure preview detected during scan
interface DetectedFolderNode {
  name: string;
  type: 'folder' | 'file';
  fileType?: FileType;          // present for file nodes
  children?: DetectedFolderNode[]; // present for folder nodes
}

// Heuristic metadata detected from archive contents and filename during the scan phase
interface DetectedImportMetadata {
  modelCount: number;           // count of detected sub-models (display only; one model is created on commit)
  fileCount: number;
  totalSizeBytes: number;
  artist: string | null;        // extracted from folder structure or filename
  tagsGuessed: string[];        // guessed from directory names; stopwords filtered
  folderStructure: DetectedFolderNode[];
}

// The DTO returned by GET /models/import-sessions and GET /models/import-sessions/:id
interface ImportSession {
  id: string;
  originalFilename: string;
  status: ImportSessionStatus;
  detected: DetectedImportMetadata | null; // null until scan completes
  modelId: string | null;       // set once commit begins
  error: string | null;
  createdAt: string;
}

type ImportSessionStatus =
  | 'scanning'
  | 'ready_for_review'
  | 'committing'
  | 'committed'
  | 'error';

// Optional per-import options sent in the commit request body
interface UploadOptions {
  markPreSupported?: boolean;
  autoThumbnails?: boolean;     // informational; auto-thumbnails always run during ingestion
  markNsfw?: boolean;
  skipDuplicatesByHash?: boolean;
}

// Batch metadata applied to the model at commit time
interface BatchUploadMetadata {
  collectionId?: string;        // assign to an existing collection
  newCollectionName?: string;   // or create and assign a new collection by name
  artist?: string;
  tags?: string[];
  options?: UploadOptions;
}
```

### Global Search Types

Defined in `packages/shared/src/types/search.ts`. Used by `GET /search`.

```typescript
interface GlobalSearchParams {
  q: string;
  limit?: number; // max hits per entity type; default 6, max 50
}

// A collection matched by name substring
interface SearchCollectionHit {
  id: string;
  name: string;
  slug: string;
  modelCount: number;
}

// An artist metadata value matched by name substring
interface SearchArtistHit {
  name: string;
  modelCount: number;
}

// A tag metadata value matched by name substring
interface SearchTagHit {
  name: string;
  modelCount: number;
}

// Aggregated response from GET /search
interface GlobalSearchResult {
  q: string;
  models: {
    items: ModelCard[];
    total: number; // total matching models, not capped by limit
  };
  collections: SearchCollectionHit[];
  artists: SearchArtistHit[];
  tags: SearchTagHit[];
}
```

---

## API Request Types

Shared validation schemas (Zod) for request bodies.

### Model Requests

```typescript
interface UpdateModelRequest {
  name?: string;
  description?: string | null;
  previewImageFileId?: string | null; // set to a ModelFile UUID to pin cover; null to revert to fallback
}
```

### Collection Requests

```typescript
interface CreateCollectionRequest {
  name: string;
  description?: string;
  parentCollectionId?: string;
}

interface UpdateCollectionRequest {
  name?: string;
  description?: string | null;
  parentCollectionId?: string | null;
}

interface AddModelsToCollectionRequest {
  modelIds: string[];
}
```

### Smart Collection Requests

```typescript
interface CreateSmartCollectionRequest {
  name: string;          // 1–255 characters
  description?: string;  // maximum 2000 characters
  definition: RuleNode;  // the rule tree
}

interface UpdateSmartCollectionRequest {
  name?: string;
  description?: string | null; // null clears the description
  definition?: RuleNode;
}

// POST /smart-collections/preview — dry-run an unsaved rule tree
interface PreviewSmartCollectionRequest {
  definition: RuleNode;
  status?: ModelStatus;
  fileType?: FileType;
  sort?: 'name' | 'createdAt' | 'totalSizeBytes';
  sortDir?: 'asc' | 'desc';
  cursor?: string;
  pageSize?: number; // default 50, max 200
}
```

Validation schemas: `createSmartCollectionSchema`, `updateSmartCollectionSchema`, `previewSmartCollectionSchema`, `smartCollectionDefinitionSchema` in `packages/shared/src/validation/smart-collection.ts`.

### Metadata Requests

```typescript
interface CreateMetadataFieldRequest {
  name: string;
  type: MetadataFieldType;
  isFilterable?: boolean;  // default: false
  isBrowsable?: boolean;   // default: false
  config?: MetadataFieldConfig;
}

interface UpdateMetadataFieldRequest {
  name?: string;
  isFilterable?: boolean;
  isBrowsable?: boolean;
  config?: MetadataFieldConfig;
}

// Sets/updates metadata on a single model
// Keys are field slugs, values are the field values
interface SetModelMetadataRequest {
  [fieldSlug: string]: string | string[] | number | boolean | null;
}
```

### Auth Requests

```typescript
interface LoginRequest {
  email: string;
  password: string;
}

interface UpdateProfileRequest {
  displayName?: string;
  email?: string;
  currentPassword?: string; // required if changing password
  newPassword?: string;
}
```

### Bulk Requests

```typescript
interface BulkMetadataRequest {
  modelIds: string[];
  operations: BulkMetadataOperation[];
}

interface BulkMetadataOperation {
  fieldSlug: string;
  action: 'set' | 'remove';
  value?: string | string[] | number | boolean;
}

interface BulkCollectionRequest {
  modelIds: string[];
  action: 'add' | 'remove';
  collectionId: string;
}

interface BulkDeleteRequest {
  modelIds: string[];
}
```

### Staged Upload Requests

```typescript
// POST /models/import-sessions/:id/commit request body
interface CommitImportSessionRequest {
  batchMetadata?: BatchUploadMetadata;
}
```

Validation schemas: `commitImportSessionSchema`, `importSessionIdParamsSchema`, `batchUploadMetadataSchema` in `packages/shared/src/validation/upload.ts`.

### Query Parameters

```typescript
// GET /models query parameters
interface ModelSearchParams {
  q?: string;                    // full-text search query
  tags?: string;                 // comma-separated tag names (case-insensitive)
  collectionId?: string;
  metadataFilters?: Record<string, string>; // dynamic metadata filters keyed by field slug
  fileType?: FileType;           // filter by presence of file type
  status?: ModelStatus;
  sort?: 'name' | 'createdAt' | 'totalSizeBytes';
  sortDir?: 'asc' | 'desc';
  cursor?: string;
  pageSize?: number;             // default: 50, max: 200
}

// GET /collections query parameters
interface CollectionListParams {
  depth?: number; // default: 1 (top-level only)
}

// GET /search query parameters
interface GlobalSearchParams {
  q: string;     // required; 1–500 characters
  limit?: number; // max hits per entity type; default 6, max 50
}
```

Validation schema: `globalSearchParamsSchema` in `packages/shared/src/validation/search.ts`.

---

## Shared Constants

Defined in `packages/shared/src/constants/index.ts` and available to both frontend and backend via `@alexandria/shared`.

### Archive Formats

```typescript
const SUPPORTED_ARCHIVE_EXTENSIONS = ['.tar.gz', '.tgz', '.zip', '.rar', '.7z'] as const;
type SupportedArchiveExtension = typeof SUPPORTED_ARCHIVE_EXTENSIONS[number];
// = '.tar.gz' | '.tgz' | '.zip' | '.rar' | '.7z'
```

`SUPPORTED_ARCHIVE_EXTENSIONS` is used by the upload validation schema (`uploadInitSchema`) and by the backend `detectArchiveExtension()` utility. The frontend `DropZone` component imports this constant directly so the accepted file type list stays in sync with the backend without duplication.

The array is ordered longest-match first so that `.tar.gz` is detected before `.gz` during suffix matching. New archive formats must be added to this constant; no other change is required in the upload path.

### Other File Classification Constants

```typescript
const SUPPORTED_IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff'] as const;
const SUPPORTED_DOCUMENT_FORMATS = ['pdf', 'txt', 'md'] as const;
const STL_EXTENSIONS = ['stl'] as const;
```

These drive `FileType` classification during ingestion. They are extension lists without a leading dot (unlike `SUPPORTED_ARCHIVE_EXTENSIONS`, which includes the dot).

---

## Type Relationship Map

```
User ──owns──→ Library ──scopes──→ Model ──has many──→ ModelFile ──has many──→ Thumbnail
  │               │                   │                     │
  │               │                   │                     └── hash (SHA-256)
  │               │                   │
  │               │                   ├──has many──→ ModelMetadata ──references──→ MetadataFieldDefinition
  │               │                   │
  │               │                   ├──has many──→ model_tags ──references──→ Tag
  │               │                   │             (optimized metadata storage)
  │               │                   │
  │               │                   └──many to many──→ Collection ──self-references──→ Collection
  │               │                       (via collection_models)     (via parentCollectionId)
  │               │
  │               ├──scopes──→ Collection
  │               │
  │               ├──scopes──→ SmartCollection  (definition: RuleNode JSONB;
  │               │               no membership table; results derived on read)
  │               │
  │               └──scopes──→ ImportSession ──(on commit)──→ Model
  │                              (staged upload; expires 24h; FK set null on model delete)
  │
  └──owns──→ Collection (via userId, for ownership; libraryId for scope)
  └──owns──→ SmartCollection (via userId, for ownership; libraryId for scope)
```

The key insights:

- Library is the top-level scope for models, collections, and smart collections. Every model, collection, and smart collection has a NOT NULL `libraryId` FK. The API enforces this via the `requireLibrary` preHandler, which injects `request.libraryId` from the session — clients never supply it.
- Tag and model_tags exist as database-level optimizations. At the API level, tags are just metadata values of type `multi_enum`. MetadataService abstracts the storage routing.
- `SmartCollection` stores only a rule tree. It has no join table and no parent/child nesting. The model result set is computed on each request by compiling the tree into SQL.
- `ImportSession` is a transient entity. It exists between `POST /models/upload` (scan enqueued) and `POST /models/import-sessions/:id/commit` (model created). The `modelId` FK is set to null on model deletion; the session row itself is deleted by the discard endpoint or reaped by the expiry cleanup.
