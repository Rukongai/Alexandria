# Alexandria — API Reference

This document describes every HTTP endpoint exposed by the Alexandria backend. It is derived from the route implementations in `apps/backend/src/routes/` and the shared validation schemas in `packages/shared/src/validation/`.

---

## Known Deviations

**`GET /models/:id/status` omits `startedAt` and `completedAt`.** The `JobStatus` type in TYPES.md includes these fields, but the route response only includes `modelId`, `status`, `progress`, and `error`. Job IDs are not stored on the model record, so detailed job timing is unavailable from this endpoint. This may be addressed in a future phase.

---

## Overview

### Base URL

In the default Docker Compose setup the backend is accessible at `http://localhost:3001`. All paths below are relative to this base.

### Envelope Format

Every response uses a consistent three-field envelope:

```json
{
  "data": <payload or null>,
  "meta": <pagination metadata or null>,
  "errors": <array of errors or null>
}
```

On success, `data` contains the payload and `errors` is `null`. On error, `data` is `null` and `errors` contains one or more error objects. The two fields never both have values simultaneously.

### Authentication

All endpoints except `POST /auth/login` require authentication. Authentication uses a signed HTTP-only session cookie named `alexandria_session`. The cookie is set by `POST /auth/login` and cleared by `POST /auth/logout`.

Requests without a valid session cookie receive a `401 Unauthorized` response.

The session mechanism uses `@fastify/cookie` with signed cookies. The cookie value is the authenticated user's ID, signed with the configured session secret. Cookie attributes: `HttpOnly`, `SameSite=Lax`, `Path=/`.

### Upload Limits

For single-request uploads (`POST /models/upload`), archive files are capped at 100 MB. For larger files, use the chunked upload protocol (`POST /models/upload/init` + chunk PUTs + `POST /models/upload/:uploadId/complete`), which supports files up to 5 GB with 10 MB chunks and per-chunk retry.

---

## Error Format

Errors are returned in the standard envelope with an `errors` array:

```json
{
  "data": null,
  "meta": null,
  "errors": [
    {
      "code": "NOT_FOUND",
      "field": null,
      "message": "Model abc123 not found"
    }
  ]
}
```

The `field` property is non-null for validation errors that are tied to a specific request field.

### Error Codes

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `VALIDATION_ERROR` | 400 | Request body or parameters failed validation |
| `UNAUTHORIZED` | 401 | No valid session cookie |
| `FORBIDDEN` | 403 | Authenticated but not permitted |
| `NOT_FOUND` | 404 | Resource does not exist |
| `CONFLICT` | 409 | Resource already exists (e.g. duplicate email) |
| `PROCESSING_FAILED` | 422 | Job or pipeline processing failed |
| `STORAGE_ERROR` | 500 | File storage operation failed |
| `IMPORT_FAILED` | 422 | Folder import configuration or execution failed |
| `INTERNAL_ERROR` | 500 | Unexpected server error (details not exposed to client) |

---

## Pagination

Paginated endpoints use cursor-based pagination. The `meta` field in the response carries pagination state:

```json
{
  "data": [...],
  "meta": {
    "total": 142,
    "cursor": "eyJpZCI6ImFiYzEyMyJ9",
    "pageSize": 50
  },
  "errors": null
}
```

`total` is the total number of matching records across all pages. `cursor` is an opaque string to pass as the `cursor` query parameter on the next request. When `cursor` is `null` there are no further pages. `pageSize` reflects the page size used for the current response.

The cursor is opaque — do not parse or construct it. Pass it back as-is to retrieve the next page.

The default page size is 50. The maximum is 200, set via the `pageSize` query parameter.

---

## Auth

### POST /auth/login

Authenticate with email and password. Sets the session cookie on success.

**Auth required:** No

**Request body:**

```json
{
  "email": "user@example.com",
  "password": "minimum8chars"
}
```

| Field | Type | Constraints |
|-------|------|-------------|
| `email` | string | Valid email format |
| `password` | string | Minimum 8 characters |

**Response (200):**

```json
{
  "data": {
    "id": "uuid",
    "email": "user@example.com",
    "displayName": "Admin",
    "role": "admin"
  },
  "meta": null,
  "errors": null
}
```

The response `data` is a `UserProfile`. The session cookie is set alongside this response.

---

### POST /auth/logout

End the current session. Clears the session cookie.

**Auth required:** No (but a session cookie is expected to be present)

**Request body:** None

**Response (200):**

```json
{
  "data": null,
  "meta": null,
  "errors": null
}
```

---

### GET /auth/me

Return the profile of the currently authenticated user.

**Auth required:** Yes

**Response (200):**

```json
{
  "data": {
    "id": "uuid",
    "email": "user@example.com",
    "displayName": "Admin",
    "role": "admin"
  },
  "meta": null,
  "errors": null
}
```

---

### PATCH /auth/me

Update the current user's profile. All fields are optional. To change the password, `currentPassword` and `newPassword` must both be provided.

**Auth required:** Yes

**Request body:**

```json
{
  "displayName": "New Name",
  "email": "newemail@example.com",
  "currentPassword": "current8chars",
  "newPassword": "new8chars"
}
```

| Field | Type | Constraints |
|-------|------|-------------|
| `displayName` | string (optional) | 1–255 characters |
| `email` | string (optional) | Valid email format |
| `currentPassword` | string (optional) | Required when providing `newPassword`; minimum 8 characters |
| `newPassword` | string (optional) | Minimum 8 characters |

**Response (200):** Returns the updated `UserProfile` in the same shape as `GET /auth/me`.

---

## Models

### GET /models

Browse and search models. Supports full-text search, metadata filters, file type filtering, collection scoping, sorting, and cursor pagination.

**Auth required:** Yes

**Query parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `q` | string | — | Full-text search query (max 500 characters) |
| `tags` | string | — | Comma-separated tag slugs to filter by |
| `collectionId` | UUID string | — | Restrict results to models in this collection |
| `fileType` | `stl` \| `image` \| `document` \| `other` | — | Filter by presence of this file type |
| `status` | `processing` \| `ready` \| `error` | — | Filter by processing status |
| `sort` | `name` \| `createdAt` \| `totalSizeBytes` | — | Sort field. When `q` is provided and `sort` is omitted, results are ordered by relevance. |
| `sortDir` | `asc` \| `desc` | — | Sort direction. Defaults to `asc` for name, `desc` for others when sort is specified explicitly. |
| `cursor` | string | — | Pagination cursor from previous response |
| `pageSize` | integer | 50 | Results per page (1–200) |
| `metadata.<fieldSlug>` | string | — | Filter by a metadata field value. For example: `metadata.artist=Maker` |

Metadata filters are passed as individual query parameters using dot notation. Multiple metadata filters may be combined. Each filter matches models that have the specified value for that field.

**Response (200):**

```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Dragon Bust",
      "slug": "dragon-bust-a3f2",
      "thumbnailUrl": "/files/thumbnails/uuid.webp",
      "metadata": [
        {
          "fieldSlug": "artist",
          "fieldName": "Artist",
          "type": "text",
          "value": "Maker Name",
          "displayValue": "Maker Name"
        },
        {
          "fieldSlug": "tags",
          "fieldName": "Tags",
          "type": "multi_enum",
          "value": ["fantasy", "bust"],
          "displayValue": "fantasy, bust"
        }
      ],
      "fileCount": 4,
      "totalSizeBytes": 8388608,
      "status": "ready",
      "createdAt": "2026-01-15T10:30:00.000Z"
    }
  ],
  "meta": {
    "total": 142,
    "cursor": "eyJpZCI6InV1aWQifQ==",
    "pageSize": 50
  },
  "errors": null
}
```

Each item in `data` is a `ModelCard`.

---

### POST /models/upload

Upload an archive file to create a new model. The upload is accepted immediately and processed asynchronously. Returns a `modelId` and `jobId` to track progress.

**Auth required:** Yes

**Request:** `multipart/form-data` with a single file field. The file must have a supported archive extension (`.zip`, `.rar`, `.7z`, `.tar.gz`, or `.tgz`) and must be 100 MB or smaller.

**Response (202):**

```json
{
  "data": {
    "modelId": "uuid",
    "jobId": "string"
  },
  "meta": null,
  "errors": null
}
```

Poll `GET /models/:id/status` with the returned `modelId` to track processing.

For files larger than 100 MB, use the chunked upload protocol described below.

---

### POST /models/upload/init

Initiate a chunked upload session. Returns an `uploadId` used to upload individual chunks and complete the upload.

**Auth required:** Yes

**Request body:**

```json
{
  "filename": "large-model.zip",
  "totalSize": 268435456,
  "totalChunks": 26
}
```

| Field | Type | Constraints |
|-------|------|-------------|
| `filename` | string | Required; 1–512 characters; must end with a supported archive extension (`.zip`, `.rar`, `.7z`, `.tar.gz`, or `.tgz`) |
| `totalSize` | integer | Required; positive; maximum 5 GB |
| `totalChunks` | integer | Required; positive; maximum 1000 |

**Response (201):**

```json
{
  "data": {
    "uploadId": "uuid",
    "expiresAt": "2026-02-23T14:00:00.000Z"
  },
  "meta": null,
  "errors": null
}
```

The session expires after 2 hours. All chunks must be uploaded and the upload completed before expiry.

---

### PUT /models/upload/:uploadId/chunk/:index

Upload a single chunk of a file. The request body must be the raw binary chunk data with `Content-Type: application/octet-stream`. Chunks are idempotent — re-uploading the same index overwrites the previous data, enabling per-chunk retry.

**Auth required:** Yes

**Path parameters:** `uploadId` — UUID from `POST /models/upload/init`; `index` — zero-based chunk index

**Request body:** Raw binary data (`application/octet-stream`)

**Response (200):**

```json
{
  "data": {
    "received": 10485760
  },
  "meta": null,
  "errors": null
}
```

`received` is the number of bytes written for this chunk.

---

### POST /models/upload/:uploadId/complete

Assemble all uploaded chunks and start ingestion processing. All chunks (0 through `totalChunks - 1`) must have been uploaded. The assembled file size must match the `totalSize` declared during init.

**Auth required:** Yes

**Path parameter:** `uploadId` — UUID from `POST /models/upload/init`

**Response (202):**

```json
{
  "data": {
    "modelId": "uuid",
    "jobId": "string"
  },
  "meta": null,
  "errors": null
}
```

Same response shape as `POST /models/upload`. Poll `GET /models/:id/status` with the returned `modelId` to track processing.

---

### POST /models/import

Start a folder import. Discovers models by walking a directory on the server's filesystem according to a hierarchy pattern, then ingests each discovered model using the specified file strategy.

**Auth required:** Yes

**Request body:**

```json
{
  "sourcePath": "/data/models",
  "pattern": "{Collection}/{metadata.Artist}/{model}",
  "strategy": "copy",
  "deleteAfterUpload": false
}
```

| Field | Type | Constraints |
|-------|------|-------------|
| `sourcePath` | string | Required. Absolute path on the server filesystem |
| `pattern` | string | Required. Hierarchy pattern; must end with `{model}`. Segments may be `{Collection}` or `{metadata.<fieldSlug>}` |
| `strategy` | `hardlink` \| `copy` \| `move` | Required. File handling strategy |
| `deleteAfterUpload` | boolean (optional) | Not applicable to local strategies; reserved for future S3 use |

**Response (202):**

```json
{
  "data": {
    "jobId": "string"
  },
  "meta": null,
  "errors": null
}
```

Unlike archive upload, this response does not include a `modelId` because the import may create multiple models.

---

### GET /models/:id/status

Poll the processing status of a model.

**Auth required:** Yes

**Path parameter:** `id` — model UUID

**Response (200):**

```json
{
  "data": {
    "modelId": "uuid",
    "status": "processing",
    "progress": null,
    "error": null
  },
  "meta": null,
  "errors": null
}
```

`status` is one of `processing`, `ready`, or `error`. `progress` is an integer 0–100 when available, otherwise `null`. `error` is a short message string when `status` is `error`, otherwise `null`.

Note: `progress` currently returns `null` while processing because job IDs are not stored on the model record. The `status` field transitions to `ready` or `error` on completion.

---

### GET /models/:id

Retrieve the full detail payload for a model.

**Auth required:** Yes

**Path parameter:** `id` — model UUID

**Response (200):**

```json
{
  "data": {
    "id": "uuid",
    "name": "Dragon Bust",
    "slug": "dragon-bust-a3f2",
    "description": "A highly detailed dragon bust for display printing.",
    "thumbnailUrl": "/files/thumbnails/uuid.webp",
    "metadata": [...],
    "sourceType": "archive_upload",
    "originalFilename": "dragon-bust.zip",
    "fileCount": 4,
    "totalSizeBytes": 8388608,
    "status": "ready",
    "collections": [
      { "id": "uuid", "name": "Fantasy", "slug": "fantasy-b2c1" }
    ],
    "images": [
      {
        "id": "uuid",
        "filename": "preview.png",
        "thumbnailUrl": "/files/thumbnails/uuid.webp",
        "originalUrl": "/files/models/model-uuid/preview.png"
      }
    ],
    "createdAt": "2026-01-15T10:30:00.000Z",
    "updatedAt": "2026-01-15T10:35:00.000Z"
  },
  "meta": null,
  "errors": null
}
```

`data` is a `ModelDetail`. `images` contains only files of type `image`, ordered by creation time. `collections` lists the collections this model belongs to as `CollectionSummary` objects. `sourceType` is one of `zip_upload` (legacy), `archive_upload` (zip, rar, 7z, or tar.gz upload), `folder_import`, or `manual`.

---

### GET /models/:id/files

Retrieve the file tree for a model. The flat list of `ModelFile` records is assembled into a nested directory tree by `PresenterService`.

**Auth required:** Yes

**Path parameter:** `id` — model UUID

**Response (200):**

```json
{
  "data": [
    {
      "name": "parts",
      "type": "directory",
      "children": [
        {
          "name": "body.stl",
          "type": "file",
          "fileType": "stl",
          "sizeBytes": 2097152,
          "id": "uuid"
        }
      ]
    },
    {
      "name": "preview.png",
      "type": "file",
      "fileType": "image",
      "sizeBytes": 204800,
      "id": "uuid"
    }
  ],
  "meta": null,
  "errors": null
}
```

`data` is an array of `FileTreeNode`. Directories appear before files at each level; both are sorted alphabetically (case-insensitive). `id` is present on file nodes only and corresponds to the `ModelFile.id`.

---

### PATCH /models/:id

Update a model's name, description, or cover image.

**Auth required:** Yes

**Path parameter:** `id` — model UUID

**Request body:**

```json
{
  "name": "Updated Model Name",
  "description": "Updated description.",
  "previewImageFileId": "uuid-of-image-file"
}
```

| Field | Type | Constraints |
|-------|------|-------------|
| `name` | string (optional) | 1–255 characters |
| `description` | string or null (optional) | Pass `null` to clear |
| `previewImageFileId` | string or null (optional) | UUID of a `ModelFile` with `fileType: "image"` to use as the model's cover image. Pass `null` to clear the pinned cover and revert to the first-image fallback. |

**Response (200):** Returns the full `ModelDetail` for the updated model, in the same shape as `GET /models/:id`.

---

### DELETE /models/:id

Delete a model and all its files from managed storage. Storage cleanup is best-effort — the model is removed from the database first, then storage paths are deleted. Storage cleanup failures are logged but do not fail the request.

**Auth required:** Yes

**Path parameter:** `id` — model UUID

**Response (200):**

```json
{
  "data": null,
  "meta": null,
  "errors": null
}
```

---

### PATCH /models/:id/metadata

Set or update metadata values on a model. The request body is a flat object mapping field slugs to values. Passing `null` as a value removes that field's metadata from the model. All provided fields are upserted atomically.

**Auth required:** Yes

**Path parameter:** `id` — model UUID

**Request body:**

```json
{
  "artist": "Maker Name",
  "year": 2024,
  "nsfw": false,
  "tags": ["fantasy", "bust"],
  "custom-field": null
}
```

Keys are field slugs. Values may be `string`, `number`, `boolean`, `string[]` (for `multi_enum` fields like tags), or `null` to remove.

**Response (200):**

```json
{
  "data": null,
  "meta": null,
  "errors": null
}
```

---

## Collections

### GET /collections

List collections belonging to the authenticated user.

**Auth required:** Yes

**Query parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `depth` | integer (1–10) | — | When provided, loads child collections up to this depth. Due to the current `CollectionDetail.children` type being `CollectionSummary[]`, depth > 1 has no visible effect on nesting in the response. |

**Response (200):**

```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Fantasy",
      "slug": "fantasy-b2c1",
      "description": "Fantasy-themed models",
      "parentCollectionId": null,
      "children": [
        { "id": "uuid", "name": "Busts", "slug": "busts-d4e5" }
      ],
      "modelCount": 12,
      "createdAt": "2026-01-10T08:00:00.000Z",
      "updatedAt": "2026-01-10T08:00:00.000Z"
    }
  ],
  "meta": {
    "total": 3,
    "cursor": null,
    "pageSize": 3
  },
  "errors": null
}
```

`data` is an array of `CollectionDetail`. The `meta.cursor` is always `null` since this endpoint returns all collections without cursor pagination.

---

### POST /collections

Create a new collection.

**Auth required:** Yes

**Request body:**

```json
{
  "name": "Terrain",
  "description": "Terrain and scenery models",
  "parentCollectionId": "uuid-of-parent"
}
```

| Field | Type | Constraints |
|-------|------|-------------|
| `name` | string | Required; 1–255 characters |
| `description` | string (optional) | Maximum 2000 characters |
| `parentCollectionId` | UUID string (optional) | Must refer to an existing collection |

**Response (201):**

```json
{
  "data": {
    "id": "uuid",
    "name": "Terrain",
    "slug": "terrain-f6g7",
    "description": "Terrain and scenery models",
    "userId": "uuid",
    "parentCollectionId": "uuid-of-parent",
    "createdAt": "2026-02-01T12:00:00.000Z",
    "updatedAt": "2026-02-01T12:00:00.000Z"
  },
  "meta": null,
  "errors": null
}
```

`data` is a `Collection` domain object.

---

### GET /collections/:id

Retrieve a single collection with its direct children and model count.

**Auth required:** Yes

**Path parameter:** `id` — collection UUID

**Response (200):**

```json
{
  "data": {
    "id": "uuid",
    "name": "Fantasy",
    "slug": "fantasy-b2c1",
    "description": "Fantasy-themed models",
    "parentCollectionId": null,
    "children": [
      { "id": "uuid", "name": "Busts", "slug": "busts-d4e5" }
    ],
    "modelCount": 12,
    "createdAt": "2026-01-10T08:00:00.000Z",
    "updatedAt": "2026-01-10T08:00:00.000Z"
  },
  "meta": null,
  "errors": null
}
```

`data` is a `CollectionDetail`. `children` is an array of `CollectionSummary` (one level deep only).

---

### PATCH /collections/:id

Update a collection's name, description, or parent.

**Auth required:** Yes

**Path parameter:** `id` — collection UUID

**Request body:**

```json
{
  "name": "Renamed Collection",
  "description": null,
  "parentCollectionId": "uuid-of-new-parent"
}
```

| Field | Type | Constraints |
|-------|------|-------------|
| `name` | string (optional) | 1–255 characters |
| `description` | string or null (optional) | Maximum 2000 characters; `null` clears the description |
| `parentCollectionId` | UUID string or null (optional) | `null` makes the collection a top-level collection; setting creates a circular-reference check |

**Response (200):** Returns the updated `CollectionDetail` (same shape as `GET /collections/:id`).

---

### DELETE /collections/:id

Delete a collection. The models inside it are not deleted — they are unlinked from the collection.

**Auth required:** Yes

**Path parameter:** `id` — collection UUID

**Response (200):**

```json
{
  "data": null,
  "meta": null,
  "errors": null
}
```

---

### GET /collections/:id/models

List models belonging to a collection. Delegates to SearchService and supports the same filtering, sorting, and pagination as `GET /models`, scoped to the collection.

**Auth required:** Yes

**Path parameter:** `id` — collection UUID

**Query parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `q` | string | Full-text search within the collection |
| `tags` | string | Comma-separated tag slugs to filter by |
| `fileType` | `stl` \| `image` \| `document` \| `other` | Filter by presence of this file type |
| `status` | `processing` \| `ready` \| `error` | Filter by processing status |
| `sort` | `name` \| `createdAt` \| `totalSizeBytes` | Sort field |
| `sortDir` | `asc` \| `desc` | Sort direction |
| `cursor` | string | Pagination cursor |
| `pageSize` | integer | Results per page (1–200, default 50) |
| `metadata.<fieldSlug>` | string | Filter by a metadata field value |

This endpoint supports the same filtering and search capabilities as `GET /models`, scoped to the specified collection. The `collectionId` is fixed to the path parameter and cannot be overridden in the query string.

**Response (200):** Same envelope shape as `GET /models`. `data` is an array of `ModelCard`.

---

### POST /collections/:id/models

Add one or more models to a collection.

**Auth required:** Yes

**Path parameter:** `id` — collection UUID

**Request body:**

```json
{
  "modelIds": ["uuid-1", "uuid-2"]
}
```

`modelIds` must be a non-empty array of valid model UUIDs.

**Response (200):**

```json
{
  "data": null,
  "meta": null,
  "errors": null
}
```

---

### DELETE /collections/:id/models/:modelId

Remove a single model from a collection without deleting the model.

**Auth required:** Yes

**Path parameters:** `id` — collection UUID, `modelId` — model UUID

**Response (200):**

```json
{
  "data": null,
  "meta": null,
  "errors": null
}
```

---

## Metadata

Metadata is the system for attaching typed attributes to models. Field definitions describe the available fields; values are the per-model assignments.

### GET /metadata/fields

List all metadata field definitions.

**Auth required:** Yes

**Response (200):**

```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Artist",
      "slug": "artist",
      "type": "text",
      "isDefault": true,
      "isFilterable": true,
      "isBrowsable": true,
      "config": null,
      "sortOrder": 0
    },
    {
      "id": "uuid",
      "name": "Tags",
      "slug": "tags",
      "type": "multi_enum",
      "isDefault": true,
      "isFilterable": true,
      "isBrowsable": true,
      "config": null,
      "sortOrder": 5
    }
  ],
  "meta": null,
  "errors": null
}
```

`data` is an array of `MetadataFieldDetail`. Default fields (`isDefault: true`) are seeded on first run and cannot be deleted.

**Field types:**

| Type | Description |
|------|-------------|
| `text` | Free-form string |
| `number` | Numeric value (stored as text, parsed by type) |
| `boolean` | `true` or `false` |
| `date` | ISO 8601 date string |
| `url` | URL string |
| `enum` | Single value from a predefined list (`config.enumOptions`) |
| `multi_enum` | Multiple values from a predefined list; Tags uses this type |

---

### POST /metadata/fields

Create a custom metadata field definition.

**Auth required:** Yes

**Request body:**

```json
{
  "name": "Scale",
  "type": "enum",
  "isFilterable": true,
  "isBrowsable": false,
  "config": {
    "enumOptions": ["1:12", "1:24", "1:48", "1:72"]
  }
}
```

| Field | Type | Constraints |
|-------|------|-------------|
| `name` | string | Required; 1–255 characters |
| `type` | MetadataFieldType | Required |
| `isFilterable` | boolean (optional) | Default: false |
| `isBrowsable` | boolean (optional) | Default: false |
| `config` | object (optional) | See below |

`config` fields:

| Field | Type | When used |
|-------|------|-----------|
| `enumOptions` | string[] | `enum` and `multi_enum` types |
| `validationPattern` | string | Optional regex for `text` type |
| `displayHint` | string | Optional frontend rendering hint |

**Response (201):** Returns the created `MetadataFieldDetail`.

---

### PATCH /metadata/fields/:id

Update a metadata field definition. The `type` and `isDefault` fields cannot be changed.

**Auth required:** Yes

**Path parameter:** `id` — field definition UUID

**Request body:**

```json
{
  "name": "Renamed Field",
  "isFilterable": true,
  "isBrowsable": true,
  "config": {
    "enumOptions": ["Option A", "Option B", "Option C"]
  }
}
```

All fields are optional.

**Response (200):** Returns the updated `MetadataFieldDetail`.

---

### DELETE /metadata/fields/:id

Delete a custom metadata field definition. Default fields (`isDefault: true`) cannot be deleted.

**Auth required:** Yes

**Path parameter:** `id` — field definition UUID

**Response (200):**

```json
{
  "data": null,
  "meta": null,
  "errors": null
}
```

---

### GET /metadata/fields/:slug/values

List distinct values recorded for a metadata field across all models, along with the count of models using each value. Useful for populating filter UIs.

**Auth required:** Yes

**Path parameter:** `slug` — field slug (e.g., `artist`, `tags`)

**Response (200):**

```json
{
  "data": [
    { "value": "Maker Name", "modelCount": 7 },
    { "value": "Another Maker", "modelCount": 2 }
  ],
  "meta": null,
  "errors": null
}
```

`data` is an array of `MetadataFieldValue`.

---

## Files

These endpoints serve binary file content directly. Responses are not enveloped — they return the raw file bytes with appropriate `Content-Type` headers.

File URLs are embedded in model payloads by `PresenterService` and should not be constructed manually.

### GET /files/thumbnails/:id.webp

Serve a WebP thumbnail by its ID. The `:id` segment is the thumbnail UUID; the `.webp` extension is part of the URL.

**Auth required:** Yes

**Path parameter:** `id.webp` — thumbnail UUID followed by `.webp` (e.g., `a1b2c3d4-....webp`)

**Response (200):** Raw WebP image bytes. `Content-Type: image/webp`. `Cache-Control: public, max-age=86400` (1 day).

---

### GET /files/models/:modelId/*

Serve a model file by its relative path within the model. The `*` wildcard captures the full relative path.

**Auth required:** Yes

**Path parameters:** `modelId` — model UUID; the remainder of the path is the file's `relativePath` value.

**Example:** `GET /files/models/abc123/parts/body.stl`

**Response (200):** Raw file bytes. `Content-Type` is set from the stored MIME type, or inferred from the file extension. `Cache-Control: public, max-age=86400` (1 day).

Supported extension-to-MIME mappings: `.webp`, `.jpg`/`.jpeg`, `.png`, `.gif`, `.tif`/`.tiff`, `.stl`, `.obj`, `.pdf`, `.txt`, `.md`. Files with unrecognized extensions return `application/octet-stream`.

Note: `.gif` is included in the MIME map above for file serving, but it is not in `SUPPORTED_IMAGE_FORMATS` and is not currently treated as an image type during ingestion. Files with a `.gif` extension are classified as `other`, will not have thumbnails generated, and will not appear in the model's `images` gallery.

---

## Bulk Operations

Bulk endpoints apply operations across multiple models in a single request.

### POST /bulk/metadata

Apply metadata operations to multiple models at once.

**Auth required:** Yes

**Request body:**

```json
{
  "modelIds": ["uuid-1", "uuid-2", "uuid-3"],
  "operations": [
    { "fieldSlug": "artist", "action": "set", "value": "New Maker" },
    { "fieldSlug": "nsfw", "action": "remove" }
  ]
}
```

| Field | Type | Constraints |
|-------|------|-------------|
| `modelIds` | UUID[] | Required; at least one |
| `operations` | BulkMetadataOperation[] | Required; at least one |

Each `BulkMetadataOperation`:

| Field | Type | Constraints |
|-------|------|-------------|
| `fieldSlug` | string | Required |
| `action` | `set` \| `remove` | Required |
| `value` | string \| string[] \| number \| boolean (optional) | Required when `action` is `set` |

**Response (200):**

```json
{
  "data": null,
  "meta": null,
  "errors": null
}
```

---

### POST /bulk/collection

Add or remove multiple models from a collection in a single request.

**Auth required:** Yes

**Request body:**

```json
{
  "modelIds": ["uuid-1", "uuid-2"],
  "action": "add",
  "collectionId": "uuid-of-collection"
}
```

| Field | Type | Constraints |
|-------|------|-------------|
| `modelIds` | UUID[] | Required; at least one |
| `action` | `add` \| `remove` | Required |
| `collectionId` | UUID string | Required |

**Response (200):**

```json
{
  "data": null,
  "meta": null,
  "errors": null
}
```

---

### POST /bulk/delete

Delete multiple models and clean up their storage in a single request. Storage cleanup is best-effort — models are removed from the database first, then storage is cleaned up. Storage failures are logged but do not fail the request.

**Auth required:** Yes

**Request body:**

```json
{
  "modelIds": ["uuid-1", "uuid-2", "uuid-3"]
}
```

`modelIds` must be a non-empty array of model UUIDs.

**Response (200):**

```json
{
  "data": {
    "deletedCount": 3,
    "deletedIds": ["uuid-1", "uuid-2", "uuid-3"]
  },
  "meta": null,
  "errors": null
}
```

`deletedIds` reflects the models that were actually removed from the database. Models that did not exist are silently skipped.

---

## Health Check

### GET /health

Returns the server's operational status. Does not require authentication.

**Response (200):**

```json
{
  "data": { "status": "ok" },
  "meta": null,
  "errors": null
}
```
