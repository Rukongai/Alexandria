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
  parentCollectionId: string | null;
  createdAt: string;
  updatedAt: string;
}
```

Join table `collection_models`: `{ collectionId: string, modelId: string }`

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
```

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
User ──owns──→ Model ──has many──→ ModelFile ──has many──→ Thumbnail
  │               │                     │
  │               │                     └── hash (SHA-256)
  │               │
  │               ├──has many──→ ModelMetadata ──references──→ MetadataFieldDefinition
  │               │
  │               ├──has many──→ model_tags ──references──→ Tag
  │               │             (optimized metadata storage)
  │               │
  │               └──many to many──→ Collection ──self-references──→ Collection
  │                   (via collection_models)     (via parentCollectionId)
  │
  └──owns──→ Collection
```

The key insight: Tag and model_tags exist as database-level optimizations. At the API level, tags are just metadata values of type `multi_enum`. MetadataService abstracts the storage routing.
