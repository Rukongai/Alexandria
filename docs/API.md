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

### Library scoping (multi-library)

Every model, collection, smart collection, and import session belongs to exactly one **library**. A user owns one or more libraries (one marked default). All list/search/detail endpoints are scoped to a single **active library**, resolved server-side as follows:

- If the request carries an **`X-Library-Id`** header, that library is used — but only after an ownership check. An unknown or un-owned id returns `404 NOT_FOUND` (same response whether it does not exist or belongs to another user, so ids cannot be enumerated).
- If the header is absent, the request falls back to the user's **default library**.

Clients never pass `libraryId` in a query string or body; scoping rides on the header only. The frontend mirrors its `/lib/:id` route segment into this header. Library membership itself is managed through the `Libraries` endpoints below.

> Note: the per-endpoint "Library scope" notes throughout this document predate P5 and say "default library". They now mean **the active library** (the `X-Library-Id` header when present, otherwise the default).

### Upload Limits

For single-request uploads (`POST /models/upload`), archive files are capped at 100 MB. For larger files, use the chunked upload protocol (`POST /models/upload/init` + chunk PUTs + `POST /models/upload/:uploadId/complete`), which supports files up to 5 GB with 10 MB chunks and per-chunk retry.

Both upload paths now use the staged ingestion workflow. They return a `sessionId` (not a `modelId`) — the model is created only after the session is committed. See the Import Sessions section below for the full scan → review → commit protocol.

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

## AI Assistant

The assistant uses user-configured, OpenAI-compatible providers. Every endpoint in this section requires authentication. Provider configuration is scoped to the authenticated user and does not use library scope. Chat and proposal application also use `requireLibrary`: send `X-Library-Id` to select an owned library, or omit it to use the user's default library.

Provider API keys are encrypted at rest and are never returned by the API. Public provider objects expose only `hasApiKey` and an identification hint containing at most the final four characters. The backend sends provider requests to `<baseUrl>/models` and `<baseUrl>/chat/completions`, with the stored key as a bearer token when one is configured. Configure only trusted endpoints because these connections originate from the backend.

### AI encryption configuration

`AI_ENCRYPTION_KEY` provides the key material for encrypting stored provider API keys. Production startup fails when it is absent, shorter than 32 characters, equal to `SESSION_SECRET`, or a checked example placeholder. Keep it separate and stable; changing the value makes existing encrypted credentials unreadable. In development only, an unset value falls back to `SESSION_SECRET`. The Docker Compose configuration requires `AI_ENCRYPTION_KEY` and passes it to the backend.

`AI_ALLOW_PRIVATE_PROVIDER_URLS` controls whether a provider may resolve to a loopback, RFC1918, or IPv6 unique-local address. It defaults to `false` in production and `true` outside production; only the literal value `true` enables it when explicitly set. Docker Compose passes it with a default of `false`. Enable it in production only when Alexandria must connect to a trusted same-host or LAN provider. Link-local addresses, known cloud-metadata hosts/addresses, multicast, and reserved targets remain blocked regardless of this setting.

### GET /ai/providers

List the authenticated user's AI providers. API keys are not included.

**Auth required:** Yes

**Library scope:** None. `X-Library-Id` does not affect the result.

**Response (200):**

```json
{
  "data": [
    {
      "id": "20c1f03d-4e5f-4e42-b5a0-a85672dc486d",
      "name": "Hosted provider",
      "baseUrl": "https://api.openai.com/v1",
      "model": "provider-model-id",
      "isDefault": true,
      "hasApiKey": true,
      "apiKeyHint": "••••7xQ2",
      "createdAt": "2026-07-21T18:20:00.000Z",
      "updatedAt": "2026-07-21T18:20:00.000Z"
    }
  ],
  "meta": {
    "total": 1,
    "cursor": null,
    "pageSize": 1
  },
  "errors": null
}
```

This list is not cursor-paginated; `meta` describes the complete result.

---

### POST /ai/providers

Create an OpenAI-compatible provider. The first provider created for a user becomes the default even when `isDefault` is omitted or `false`. Creating another provider with `isDefault: true` demotes the prior default. Default-selection writes are serialized per user, so concurrent provider requests preserve one deterministic default.

**Auth required:** Yes

**Library scope:** None.

**Request body:**

```json
{
  "name": "Hosted provider",
  "baseUrl": "https://api.openai.com/v1/",
  "apiKey": "secret-token",
  "model": "provider-model-id",
  "isDefault": true
}
```

| Field | Type | Constraints |
|-------|------|-------------|
| `name` | string | Required; trimmed; 1–255 characters |
| `baseUrl` | string | Required; maximum 2,048 characters; host must resolve within 3 seconds; no embedded username/password; public targets require HTTPS; HTTP is allowed only when all resolved addresses are private/loopback and private providers are enabled |
| `apiKey` | string | Optional; maximum 4,096 characters; an empty string is stored as no key |
| `model` | string | Required; trimmed; 1–255 characters |
| `isDefault` | boolean | Optional; defaults to `false`, except that the user's first provider is always made default |

The server removes the base URL query, fragment, and trailing slashes before storing it. Preserve any path prefix required by the provider, such as `/v1`.

**Response (201):** Returns the created `AiProvider` in the same public shape as an item from `GET /ai/providers`.

---

### PATCH /ai/providers/:id

Update an owned provider. Omitted fields retain their current values.

**Auth required:** Yes

**Library scope:** None.

**Path parameter:** `id` — provider UUID. A missing or other user's provider returns `404 NOT_FOUND`.

**Request body:**

```json
{
  "model": "new-provider-model-id",
  "apiKey": null,
  "isDefault": true
}
```

| Field | Type | Constraints |
|-------|------|-------------|
| `name` | string | Optional; trimmed; 1–255 characters |
| `baseUrl` | string | Optional; maximum 2,048 characters; host must resolve within 3 seconds; no embedded username/password; public targets require HTTPS; HTTP is allowed only when all resolved addresses are private/loopback and private providers are enabled |
| `apiKey` | string or `null` | Optional; maximum 4,096 characters; `null` or an empty string clears the stored key; omission retains it |
| `model` | string | Optional; trimmed; 1–255 characters |
| `isDefault` | boolean | Optional; `true` promotes this provider and demotes the prior default |

At least one field is required. If the current default is set to `false`, the oldest remaining provider becomes default. A user's only provider cannot be left non-default: it remains default.

**Response (200):** Returns the updated public `AiProvider`.

---

### DELETE /ai/providers/:id

Delete an owned provider and its encrypted credential. If it was the default, the oldest remaining provider becomes default.

**Auth required:** Yes

**Library scope:** None.

**Path parameter:** `id` — provider UUID. A missing or other user's provider returns `404 NOT_FOUND`.

**Response (200):**

```json
{
  "data": null,
  "meta": null,
  "errors": null
}
```

---

### POST /ai/providers/:id/test

Test an owned provider by requesting its OpenAI-compatible `GET /models` endpoint. A successful result confirms that the request completed and the response contained a `data` array; it does not send a chat completion.

**Auth required:** Yes

**Library scope:** None.

**Path parameter:** `id` — provider UUID.

**Request body:** None

**Response (200):**

```json
{
  "data": {
    "ok": true,
    "modelCount": 12
  },
  "meta": null,
  "errors": null
}
```

Provider HTTP errors, timeouts, oversized responses, invalid JSON, or an invalid models response return `422 PROCESSING_FAILED`. DNS lookup is capped at 3 seconds. Every resolved address is classified before each request hop, and the complete deduplicated vetted address set is pinned for socket connection and failover without re-resolution while the original hostname remains in HTTP Host and TLS SNI. IPv4-mapped addresses are classified by their embedded IPv4 target; IPv4 translation/transition ranges including NAT64, 6to4, Teredo, IPv4-compatible, and ISATAP addresses are blocked. Each short-lived pinned dispatcher is closed after its response is consumed or cancelled. Each provider operation has one 10-second deadline shared by validation, all redirect hops, failover attempts, and response reading; its response body is capped at 2 MiB. Alexandria does not include the upstream response body in the client-facing error.

Every outbound request re-resolves and checks its target against the provider-network policy. Redirects are followed manually for at most three hops, must remain on the original origin, and are revalidated before each hop. A cross-origin, blocked, missing-location, or excessive redirect returns `422 PROCESSING_FAILED`.

---

### GET /ai/providers/:id/models

Discover models from an owned provider's OpenAI-compatible `GET /models` endpoint. Entries without a string `id` are omitted and the remaining entries are sorted by `id`.

**Auth required:** Yes

**Library scope:** None.

**Path parameter:** `id` — provider UUID.

**Response (200):**

```json
{
  "data": [
    {
      "id": "provider-model-id",
      "ownedBy": "provider"
    },
    {
      "id": "provider-model-id-larger",
      "ownedBy": null
    }
  ],
  "meta": {
    "total": 2,
    "cursor": null,
    "pageSize": 2
  },
  "errors": null
}
```

The upstream `owned_by` field is exposed as `ownedBy`; missing or non-string values become `null`. This result is not cursor-paginated. Provider failures use the same `422 PROCESSING_FAILED` behavior as the test endpoint.

---

### POST /ai/chat

Send one assistant turn through the selected provider. The assistant can search and inspect models only in the active library. It may also use public lookup tools and can create one reviewable change proposal, but it cannot mutate library data during chat.

**Auth required:** Yes

**Library scope:** Required. `X-Library-Id` selects the active owned library; an absent header selects the default. An unknown or un-owned library returns `404 NOT_FOUND`.

**Request body:**

```json
{
  "message": "Find the artist for this model and propose adding it.",
  "history": [
    {
      "role": "user",
      "content": "Help me clean up this model."
    },
    {
      "role": "assistant",
      "content": "What would you like me to research?"
    }
  ],
  "providerId": "20c1f03d-4e5f-4e42-b5a0-a85672dc486d",
  "context": {
    "modelId": "11de19f0-3164-4f86-8741-b876777f7d17"
  }
}
```

| Field | Type | Constraints |
|-------|------|-------------|
| `message` | string | Required; trimmed; 1–4,000 characters |
| `history` | array | Optional; at most 20 messages; `message` plus all history content is limited to 32,000 characters total |
| `history[].role` | `user` \| `assistant` | Required for each history item |
| `history[].content` | string | Required; 1–8,000 characters |
| `providerId` | UUID string | Optional; must identify the user's provider; omission uses the user's default provider |
| `context.modelId` | UUID string | Optional; must identify a model owned by the user in the active library |

The backend does not persist chat transcripts. It sends the supplied message and history to the selected external provider. When `context.modelId` is present, it verifies ownership and active-library membership before also sending the assembled model detail as an explicitly untrusted user-role payload, not as a privileged system instruction. Tool results needed for the turn—including library search/model content and public search results—are also sent to that provider and are labeled as untrusted data.

**Response (200):**

```json
{
  "data": {
    "message": "I found a likely artist and prepared a metadata update for review.",
    "sources": [
      {
        "title": "Dragon Bust by Example Studio",
        "url": "https://example.org/dragon-bust",
        "snippet": "A printable dragon bust by Example Studio."
      },
      {
        "title": "Dragon bust reference.jpg",
        "url": "https://commons.wikimedia.org/wiki/File:Dragon_bust_reference.jpg",
        "imageUrl": "https://upload.wikimedia.org/example/500px-Dragon_bust_reference.jpg"
      }
    ],
    "proposal": {
      "proposalId": "93b39b94-bad1-4cdd-a5d8-c36d03935225",
      "summary": "Set the Artist metadata field on Dragon Bust",
      "changes": [
        {
          "type": "set_metadata",
          "modelId": "11de19f0-3164-4f86-8741-b876777f7d17",
          "modelName": "Dragon Bust",
          "values": {
            "artist": "Example Studio"
          }
        }
      ],
      "expiresAt": "2026-07-21T18:35:00.000Z",
      "display": {
        "collections": {},
        "images": {}
      }
    }
  },
  "meta": null,
  "errors": null
}
```

`sources` contains unique source URLs gathered during this turn, up to 24. `snippet` and `imageUrl` are optional. `proposal` is `null` when the provider did not request a valid preview. When a proposal exists, `display.collections` maps referenced collection UUIDs to server-resolved names and `display.images` maps referenced model-file UUIDs to `{ filename, thumbnailUrl }`. These presentation maps let the review UI show human-readable targets while `changes` remains the exact immutable payload. The shared field is optional for compatibility; newly created previews populate it, using empty maps when no collection or image IDs need resolution.

Public text lookup uses DuckDuckGo's Instant Answer API and returns at most eight abstract/related-topic sources; it is not a general crawl of arbitrary pages. Image lookup uses Wikimedia Commons and returns at most eight file-page and thumbnail candidates. Both services are keyless, use a 7-second timeout and 1 MiB response-body limit, and fail safely as an unavailable tool result so the assistant may still answer. Returned image URLs are research candidates only: the backend does not import them into managed storage, although the frontend may load a returned thumbnail to display its source card. An AI cover change can reference only an image file already belonging to the target model.

The complete chat operation has a 45-second deadline; provider and public-search calls receive the remaining time, bounded further by their own 10-second and 7-second limits. If the client disconnects while chat is running, the cancellation signal is propagated to active provider and public-search fetches. Provider resolution, model-context reads, library/model tools, and proposal creation are raced against the same cancellation/deadline boundary. Because PostgreSQL queries are not cancelled by that JavaScript race, the shared pool additionally enforces a 5-second connection-acquisition timeout, 45-second server statement timeout, and 50-second client query timeout so abandoned work cannot remain unbounded. Preview validation and insertion use one transaction with the operation deadline applied locally and cancellation/deadline checks around the insert, so an abandoned mutating tool cannot commit a late proposal. Each user may start at most 10 chats per rolling minute and run at most two chats concurrently; exceeding either limit returns `429 PROCESSING_FAILED`. The limiter is process-local, bounded to 10,000 tracked users, and resets when the backend restarts, which is appropriate for the current single-instance deployment but must be replaced by shared state before horizontally scaling the backend. The provider tool loop accepts at most one proposal per response and applies these resource limits: six provider turns, eight tool calls per turn, 12 tool calls total, 20,000 argument characters per call, 40,000 argument characters total, 12,000 result characters per tool, 48,000 result characters total, and 64,000 serialized provider-context characters. The returned assistant message is capped at 16,000 characters. Provider failures, invalid/empty responses, or exceeding a deadline, turn, tool, argument, result, or context budget return `422 PROCESSING_FAILED`; an overlong final message is truncated. Expected tool errors sent back through the provider loop are length-bounded, while unexpected internal and database errors are replaced with `Tool call failed` rather than exposing their messages to the provider.

#### Proposal validation

There is intentionally no client-facing endpoint for creating a proposal. The provider's only change-capable tool is the internal `preview_changes` tool. Before storing a preview, the server validates a non-empty summary of at most 1,000 characters and 1–25 changes. Each model must belong to the authenticated user and active library, and `modelName` must exactly match its current name.

The supported changes are:

- `update_model`: a non-empty patch containing only `name` (1–255 characters), `description` (string up to 20,000 characters or `null`), or `previewImageFileId` (UUID or `null`). A non-null preview file must be an image belonging to that model. Crop changes are not supported by AI proposals.
- `set_metadata`: a non-empty object keyed by existing metadata-field slug. `null` clears a value; numbers must be finite, booleans must be booleans, `multi_enum` values must be string arrays, and other field types require strings.
- `update_collections`: `addCollectionIds` and `removeCollectionIds` are arrays of at most 50 UUIDs each. At least one ID is required, an ID cannot appear in both arrays, and every collection must belong to the user and active library.

The resulting proposal is immutable, server-owned, scoped to the user and active library, and expires 15 minutes after creation.

---

### POST /ai/proposals/:id/apply

Apply the exact stored changes from a prior assistant preview. The request accepts a proposal ID only—there is no request body and no way for the client to replace or amend the proposed changes. This preview-before-apply separation is a server-enforced invariant, not only a frontend confirmation step.

**Auth required:** Yes

**Library scope:** Required. The active library must match the proposal's stored library. A proposal belonging to another user or library returns `404 NOT_FOUND`.

**Path parameter:** `id` — proposal UUID returned in `AiChangePreview`.

**Request body:** None

**Response (200):**

```json
{
  "data": {
    "proposalId": "93b39b94-bad1-4cdd-a5d8-c36d03935225",
    "status": "applied",
    "changedModelIds": [
      "11de19f0-3164-4f86-8741-b876777f7d17"
    ]
  },
  "meta": null,
  "errors": null
}
```

Immediately before applying, the server reloads the stored payload and enters the mutation transaction. It locks every referenced model row `FOR UPDATE` in deterministic model-ID order, then revalidates model names, ownership, active-library scope, metadata fields, image files, and collections through that same transaction executor. Only after revalidation does it conditionally change the proposal from `pending` to `applying`; this atomic claim prevents concurrent requests from applying it twice, while the model locks prevent two independently previewed stale-name proposals from both overwriting the same model. Apply-time expiry checks use the database clock.

A proposal can be applied once successfully and only while its 15-minute review window is open. Expired proposals and non-pending proposals return `409 CONFLICT` and cannot be replayed. Expiry is enforced when applying; this endpoint does not expose or renew expired proposals.

The conditional claim, all proposed model/metadata/collection writes, and the final `applied` status run in one database transaction. If any operation fails or the process exits before commit, every domain change and the claim are rolled back together. The proposal remains `pending` and may be retried while unexpired and still valid; there is no committed `applying` state to strand.

An invalid proposal UUID returns `400 VALIDATION_ERROR`; a missing, un-owned, or wrong-library proposal returns `404 NOT_FOUND`. A stale live reference can return `404 NOT_FOUND` or `400 VALIDATION_ERROR` during revalidation. An invalid stored payload, expiry, prior use, or a concurrent claim returns `409 CONFLICT`.

---

## Models

### GET /models

Browse and search models. Supports full-text search, metadata filters, file type filtering, collection scoping, sorting, and cursor pagination.

**Auth required:** Yes

**Library scope:** Results are automatically scoped to the authenticated user's default library. The library is resolved server-side from the session; clients do not pass (and must not pass) a `libraryId`.

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

Upload an archive file to begin the staged ingestion workflow. The file is accepted, an import session is created, and a scan job is enqueued. Returns a `sessionId` — not a model ID. The model is created only after the session is committed via `POST /models/import-sessions/:id/commit`.

**Auth required:** Yes

**Library scope:** The import session is created in the authenticated user's default library, resolved server-side from the session. Clients do not pass a `libraryId`.

**Request:** `multipart/form-data` with a single file field. The file must have a supported archive extension (`.zip`, `.rar`, `.7z`, `.tar.gz`, or `.tgz`) and must be 100 MB or smaller.

**Response (202):**

```json
{
  "data": {
    "sessionId": "uuid"
  },
  "meta": null,
  "errors": null
}
```

Poll `GET /models/import-sessions/:id` with the returned `sessionId` to track scan progress and retrieve detected metadata. Once the session reaches `ready_for_review`, commit it with `POST /models/import-sessions/:id/commit`.

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

Assemble all uploaded chunks and begin the staged ingestion workflow. All chunks (0 through `totalChunks - 1`) must have been uploaded. The assembled file size must match the `totalSize` declared during init.

**Auth required:** Yes

**Library scope:** The import session is created in the authenticated user's default library, resolved server-side from the session. Clients do not pass a `libraryId`.

**Path parameter:** `uploadId` — UUID from `POST /models/upload/init`

**Response (202):**

```json
{
  "data": {
    "sessionId": "uuid"
  },
  "meta": null,
  "errors": null
}
```

Same staged contract as `POST /models/upload`. Poll `GET /models/import-sessions/:id` with the returned `sessionId` to track scan progress, then commit via `POST /models/import-sessions/:id/commit`.

---

### POST /models/import

Start a folder import. Discovers models by walking a directory on the server's filesystem according to a hierarchy pattern, then ingests each discovered model using the specified file strategy.

**Auth required:** Yes

**Library scope:** All models created by this import are assigned to the authenticated user's default library, resolved server-side from the session. Clients do not pass a `libraryId`.

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

### GET /models/import-sessions

List the authenticated user's active import sessions for the current library. Active sessions include those with status `scanning`, `ready_for_review`, `committing`, or `error`. Committed and expired sessions are not returned.

**Auth required:** Yes

**Library scope:** Results are scoped to the authenticated user's default library, resolved server-side from the session. Clients do not pass a `libraryId`.

**Response (200):**

```json
{
  "data": [
    {
      "id": "uuid",
      "originalFilename": "dragon-bust.zip",
      "status": "ready_for_review",
      "detected": {
        "modelCount": 1,
        "fileCount": 14,
        "totalSizeBytes": 8388608,
        "artist": "Maker Name",
        "tagsGuessed": ["fantasy", "bust"],
        "folderStructure": [
          { "name": "parts", "type": "folder", "children": [
            { "name": "body.stl", "type": "file", "fileType": "stl" }
          ]}
        ]
      },
      "modelId": null,
      "error": null,
      "createdAt": "2026-05-30T10:00:00.000Z"
    }
  ],
  "meta": null,
  "errors": null
}
```

`data` is an array of `ImportSession`. The `detected` field is `null` while the session is still scanning. Session TTL is 24 hours — sessions not committed within that window may be reaped.

---

### GET /models/import-sessions/:id

Retrieve a single import session. Use this to poll scan progress and retrieve detected metadata.

**Auth required:** Yes

**Path parameter:** `id` — import session UUID

**Response (200):**

```json
{
  "data": {
    "id": "uuid",
    "originalFilename": "dragon-bust.zip",
    "status": "ready_for_review",
    "detected": {
      "modelCount": 1,
      "fileCount": 14,
      "totalSizeBytes": 8388608,
      "artist": "Maker Name",
      "tagsGuessed": ["fantasy", "bust"],
      "folderStructure": [...]
    },
    "modelId": null,
    "error": null,
    "createdAt": "2026-05-30T10:00:00.000Z"
  },
  "meta": null,
  "errors": null
}
```

`data` is an `ImportSession`. `status` transitions: `scanning` → `ready_for_review` on success, or `scanning` → `error` on failure. Poll until status leaves `scanning`.

---

### POST /models/import-sessions/:id/commit

Commit a reviewed import session, creating a model and enqueuing the full ingestion pipeline. The session must be in `ready_for_review` status.

**Auth required:** Yes

**Library scope:** The model is created in the authenticated user's default library, resolved server-side from the session.

**Path parameter:** `id` — import session UUID

**Request body (optional):**

```json
{
  "batchMetadata": {
    "collectionId": "uuid-of-existing-collection",
    "newCollectionName": "My New Collection",
    "artist": "Maker Name",
    "tags": ["fantasy", "bust"],
    "options": {
      "markPreSupported": false,
      "markNsfw": false,
      "skipDuplicatesByHash": false
    }
  }
}
```

`batchMetadata` is fully optional. `collectionId` and `newCollectionName` are mutually exclusive — use one or neither. All metadata detected during scan can be overridden or supplemented here.

| Field | Type | Constraints |
|-------|------|-------------|
| `batchMetadata` | object (optional) | Batch metadata to apply to the committed model |
| `batchMetadata.collectionId` | UUID string (optional) | Assign model to an existing collection |
| `batchMetadata.newCollectionName` | string (optional) | Create a new collection and assign the model to it (1–255 chars) |
| `batchMetadata.artist` | string (optional) | Override detected artist (max 255 chars) |
| `batchMetadata.tags` | string[] (optional) | Override detected tags (max 50 tags, each max 100 chars) |
| `batchMetadata.options.markPreSupported` | boolean (optional) | Mark model as pre-supported |
| `batchMetadata.options.markNsfw` | boolean (optional) | Mark model as NSFW |
| `batchMetadata.options.skipDuplicatesByHash` | boolean (optional) | Skip if a model with the same file hash already exists |

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

Poll `GET /models/:id/status` with the returned `modelId` to track ingestion progress.

---

### DELETE /models/import-sessions/:id

Discard an import session and delete its staged files. The session can be in any active status.

**Auth required:** Yes

**Path parameter:** `id` — import session UUID

**Response (200):**

```json
{
  "data": null,
  "meta": null,
  "errors": null
}
```

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

### GET /models/:id/download

Download all files belonging to a model as a ZIP archive. The archive is assembled and streamed from managed storage; the original directory structure is preserved and the full archive is never buffered in server memory.

**Auth required:** Yes. The authenticated user must own the model.

**Path parameter:** `id` — model UUID

**Response (200):** A streamed `application/zip` attachment named `<model-slug>.zip`.

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

## Libraries

Manage the libraries a user owns. These endpoints manage the library scope itself, so they are **not** scoped by the `X-Library-Id` header — they operate on the authenticated user's full set of libraries, identified by the URL `:id`. See [Library scoping](#library-scoping-multi-library).

### GET /libraries

List the authenticated user's libraries with derived model and collection counts. Ordered default-first, then oldest-first. Drives the All-Libraries home and the rail switcher.

**Auth required:** Yes

**Response (200):**

```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Main",
      "slug": "main-a1b2",
      "userId": "uuid",
      "isDefault": true,
      "color": "amber",
      "modelCount": 142,
      "collectionCount": 7,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "meta": { "total": 1, "cursor": null, "pageSize": 1 },
  "errors": null
}
```

`data` is an array of `LibrarySummary` (a `Library` plus `modelCount` / `collectionCount`).

---

### POST /libraries

Create a new (non-default) library.

**Auth required:** Yes

**Request body:**

| Field | Type | Constraints |
|-------|------|-------------|
| `name` | string | Required; 1–255 characters |
| `color` | string (optional) | One of `amber`, `teal`, `sage`, `plum`, `slate` (default `amber`) |

**Response (201):** the created `LibrarySummary` (`modelCount` / `collectionCount` are `0`).

---

### PATCH /libraries/:id

Rename and/or recolor a library. Renaming regenerates the slug. At least one of `name` / `color` must be provided. A library not owned by the user returns `404 NOT_FOUND`.

**Auth required:** Yes

**Path parameter:** `id` — library UUID

**Request body:** `name` (optional, 1–255), `color` (optional enum, as above).

**Response (200):** the updated `LibrarySummary`.

---

### POST /libraries/:id/set-default

Mark a library as the user's default. The prior default is cleared in the same transaction, so exactly one library is default at all times. A library not owned by the user returns `404 NOT_FOUND`.

**Auth required:** Yes

**Path parameter:** `id` — library UUID

**Response (200):** `{ "data": null, "meta": null, "errors": null }`

---

### DELETE /libraries/:id

Delete a library. Refused (`409 CONFLICT`) when the library is the default, is the user's only library, or still contains any models or collections (move or remove its contents first). A library not owned by the user returns `404 NOT_FOUND`.

**Auth required:** Yes

**Path parameter:** `id` — library UUID

**Response (200):** `{ "data": null, "meta": null, "errors": null }`

---

## Collections

### GET /collections

List collections belonging to the active library.

**Auth required:** Yes

**Library scope:** Results are scoped to the authenticated user's default library, resolved server-side from the session. Clients do not pass a `libraryId`.

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

Create a new collection in the authenticated user's default library.

**Auth required:** Yes

**Library scope:** The new collection is created in the authenticated user's default library, resolved server-side from the session. Clients do not pass a `libraryId`.

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

List models belonging to a collection. Delegates to SearchService and supports the same filtering, sorting, and pagination as `GET /models`, scoped to both the collection and the authenticated user's default library.

**Auth required:** Yes

**Library scope:** Results are scoped to the authenticated user's default library in addition to the specified collection. The library is resolved server-side from the session; clients do not pass a `libraryId`.

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

## Smart Collections

Smart collections are dynamic, rule-based collections. Instead of managing explicit membership, a smart collection stores a rule tree (`definition`) that is compiled into SQL and executed on every read. The result set is derived — never persisted. There is no join table.

The `definition` field is a `RuleNode` — a recursive tree of groups (AND/OR) and leaf conditions. See `docs/TYPES.md` for the full type hierarchy.

### GET /smart-collections

List smart collections in the authenticated user's default library. Model counts are omitted from the list response to keep it cheap; use `GET /smart-collections/:id` for a live count.

**Auth required:** Yes

**Library scope:** Results are scoped to the authenticated user's default library, resolved server-side from the session. Clients do not pass a `libraryId`.

**Response (200):**

```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Ready Fantasy Models",
      "slug": "ready-fantasy-models-a3f2",
      "description": "All ready models tagged fantasy",
      "definition": {
        "kind": "group",
        "op": "and",
        "children": [
          { "kind": "condition", "field": { "source": "builtin", "field": "tag" }, "operator": "hasTag", "value": "fantasy" },
          { "kind": "condition", "field": { "source": "builtin", "field": "status" }, "operator": "is", "value": "ready" }
        ]
      },
      "userId": "uuid",
      "createdAt": "2026-05-01T10:00:00.000Z",
      "updatedAt": "2026-05-01T10:00:00.000Z"
    }
  ],
  "meta": { "total": 1, "cursor": null, "pageSize": 1 },
  "errors": null
}
```

`data` is an array of `SmartCollection`. The `meta.cursor` is always `null`; this endpoint returns all smart collections for the library without cursor pagination.

---

### POST /smart-collections

Create a smart collection.

**Auth required:** Yes

**Library scope:** The new smart collection is created in the authenticated user's default library, resolved server-side from the session.

**Request body:**

```json
{
  "name": "Ready Fantasy Models",
  "description": "All ready models tagged fantasy",
  "definition": {
    "kind": "group",
    "op": "and",
    "children": [
      { "kind": "condition", "field": { "source": "builtin", "field": "tag" }, "operator": "hasTag", "value": "fantasy" },
      { "kind": "condition", "field": { "source": "builtin", "field": "status" }, "operator": "is", "value": "ready" }
    ]
  }
}
```

| Field | Type | Constraints |
|-------|------|-------------|
| `name` | string | Required; 1–255 characters |
| `description` | string (optional) | Maximum 2000 characters |
| `definition` | RuleNode | Required; a valid rule tree (see below) |

**Rule tree validation:** The tree must not exceed depth 3 (group nesting), 50 total nodes, or 20 children per group. A bare condition or an empty root group (`{ kind: "group", op: "and", children: [] }`) is valid. For leaf conditions: the operator must be legal for the field (e.g., `contains` and `equals` for `name`; `hasTag`/`notHasTag` for `tag`). Operators `exists` and `notExists` take a null value; all others require a non-empty string. Metadata field slugs are validated server-side against the live field definitions; unknown slugs return `400`.

**Response (201):** Returns the created `SmartCollectionDetail` (includes a live `modelCount`).

```json
{
  "data": {
    "id": "uuid",
    "name": "Ready Fantasy Models",
    "slug": "ready-fantasy-models-a3f2",
    "description": "All ready models tagged fantasy",
    "definition": { ... },
    "modelCount": 7,
    "createdAt": "2026-05-01T10:00:00.000Z",
    "updatedAt": "2026-05-01T10:00:00.000Z"
  },
  "meta": null,
  "errors": null
}
```

**Error cases:**

| Code | Status | When |
|------|--------|------|
| `VALIDATION_ERROR` | 400 | Tree fails structural validation (depth, node count, illegal operator for field) |
| `VALIDATION_ERROR` | 400 | A `metadata` leaf references an unknown field slug |
| `VALIDATION_ERROR` | 400 | A `metadata` leaf uses an operator that is illegal for the field's type |

---

### GET /smart-collections/:id

Retrieve a single smart collection, including a live count of models the rule tree currently matches.

**Auth required:** Yes

**Library scope:** The smart collection must belong to the authenticated user's default library. Mismatches return `404`.

**Path parameter:** `id` — smart collection UUID

**Response (200):** Returns a `SmartCollectionDetail`.

```json
{
  "data": {
    "id": "uuid",
    "name": "Ready Fantasy Models",
    "slug": "ready-fantasy-models-a3f2",
    "description": "All ready models tagged fantasy",
    "definition": { ... },
    "modelCount": 7,
    "createdAt": "2026-05-01T10:00:00.000Z",
    "updatedAt": "2026-05-01T10:00:00.000Z"
  },
  "meta": null,
  "errors": null
}
```

`modelCount` is derived live by running the rule tree against the library — it reflects the current state of the model set.

---

### PATCH /smart-collections/:id

Update a smart collection's name, description, or rule tree. All fields are optional; at least one must be provided.

**Auth required:** Yes

**Library scope:** The smart collection must belong to the authenticated user's default library. Mismatches return `404`.

**Path parameter:** `id` — smart collection UUID

**Request body:**

```json
{
  "name": "Renamed Collection",
  "description": null,
  "definition": {
    "kind": "condition",
    "field": { "source": "builtin", "field": "tag" },
    "operator": "hasTag",
    "value": "sci-fi"
  }
}
```

| Field | Type | Constraints |
|-------|------|-------------|
| `name` | string (optional) | 1–255 characters |
| `description` | string or null (optional) | Maximum 2000 characters; `null` clears the description |
| `definition` | RuleNode (optional) | Must pass the same validation as `POST /smart-collections` |

When `name` is updated the slug is regenerated. If `definition` is provided, `resolveAndCompile` runs the full validation before the update is written to the database.

**Response (200):** Returns the updated `SmartCollectionDetail`.

---

### DELETE /smart-collections/:id

Delete a smart collection. Models are not affected — only the rule tree and its metadata are removed.

**Auth required:** Yes

**Library scope:** The smart collection must belong to the authenticated user's default library. Mismatches return `404`.

**Path parameter:** `id` — smart collection UUID

**Response (200):**

```json
{
  "data": null,
  "meta": null,
  "errors": null
}
```

---

### GET /smart-collections/:id/models

Execute the rule tree and return the derived model result set. Supports the same filtering, sorting, and pagination as `GET /models` — these parameters are ANDed on top of the compiled rule tree.

**Auth required:** Yes

**Library scope:** Results are scoped to the authenticated user's default library in addition to the rule tree's constraints. The library is resolved server-side; clients do not pass a `libraryId`.

**Path parameter:** `id` — smart collection UUID

**Query parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `q` | string | Full-text search within the rule-derived set |
| `tags` | string | Comma-separated tag slugs to further filter by |
| `fileType` | `stl` \| `image` \| `document` \| `other` | Filter by presence of this file type |
| `status` | `processing` \| `ready` \| `error` | Filter by processing status |
| `sort` | `name` \| `createdAt` \| `totalSizeBytes` | Sort field |
| `sortDir` | `asc` \| `desc` | Sort direction |
| `cursor` | string | Pagination cursor |
| `pageSize` | integer | Results per page (1–200, default 50) |
| `metadata.<fieldSlug>` | string | Filter by a metadata field value |

**Response (200):** Same envelope shape as `GET /models`. `data` is an array of `ModelCard`.

---

### POST /smart-collections/preview

Dry-run an unsaved rule tree against the authenticated user's library. Useful for live feedback in the rule composer before creating or saving a smart collection.

**Auth required:** Yes

**Library scope:** Results are scoped to the authenticated user's default library, resolved server-side from the session.

**Request body:**

```json
{
  "definition": {
    "kind": "group",
    "op": "or",
    "children": [
      { "kind": "condition", "field": { "source": "builtin", "field": "tag" }, "operator": "hasTag", "value": "fantasy" },
      { "kind": "condition", "field": { "source": "builtin", "field": "tag" }, "operator": "hasTag", "value": "sci-fi" }
    ]
  },
  "sort": "name",
  "sortDir": "asc",
  "pageSize": 20
}
```

| Field | Type | Constraints |
|-------|------|-------------|
| `definition` | RuleNode | Required; same validation as `POST /smart-collections` |
| `status` | `processing` \| `ready` \| `error` (optional) | Additional status filter |
| `fileType` | `stl` \| `image` \| `document` \| `other` (optional) | Additional file-type filter |
| `sort` | `name` \| `createdAt` \| `totalSizeBytes` (optional) | Sort field |
| `sortDir` | `asc` \| `desc` (optional) | Sort direction |
| `cursor` | string (optional) | Pagination cursor |
| `pageSize` | integer (optional) | Results per page (1–200, default 50) |

**Response (200):** Same envelope shape as `GET /models`. `data` is an array of `ModelCard`.

**Error cases:**

| Code | Status | When |
|------|--------|------|
| `VALIDATION_ERROR` | 400 | Tree fails structural validation |
| `VALIDATION_ERROR` | 400 | Unknown metadata slug or illegal operator for field's type |

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

List distinct values recorded for a metadata field across models in the authenticated user's default library, along with the count of models using each value. Useful for populating filter UIs such as the AxisFacetBody in the Pivot Workspace.

**Auth required:** Yes

**Library scope:** Values and counts are scoped to the authenticated user's default library, resolved server-side from the session. Clients do not pass a `libraryId`.

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
    { "fieldSlug": "tags", "action": "add", "value": ["tabletop", "terrain"] },
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
| `action` | `set` \| `add` \| `remove` | Required; `add` appends tags without replacing existing tags |
| `value` | string \| string[] \| number \| boolean (optional) | Required when `action` is `set` or `add` |

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

Add, remove, or move multiple models to a collection in a single request. Moving replaces all existing collection memberships for the selected models with the destination collection.

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
| `action` | `add` \| `remove` \| `move` | Required |
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

## Search

### GET /search

Cross-entity search across models, collections, artists, and tags in a single request. Each result type is scored and limited independently. Requires an active library.

**Auth required:** Yes

**Library scope:** All results are scoped to the authenticated user's default library, resolved server-side from the session. Clients do not pass a `libraryId`.

**Query parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `q` | string | — | Required. Search query (1–500 characters) |
| `limit` | integer | 6 | Maximum results per entity type (1–50) |

**Response (200):**

```json
{
  "data": {
    "q": "dragon",
    "models": {
      "items": [
        {
          "id": "uuid",
          "name": "Dragon Bust",
          "slug": "dragon-bust-a3f2",
          "thumbnailUrl": "/files/thumbnails/uuid.webp",
          "metadata": [...],
          "fileCount": 4,
          "totalSizeBytes": 8388608,
          "status": "ready",
          "createdAt": "2026-01-15T10:30:00.000Z"
        }
      ],
      "total": 3
    },
    "collections": [
      { "id": "uuid", "name": "Dragons", "slug": "dragons-b1c2", "modelCount": 8 }
    ],
    "artists": [
      { "name": "DragonArtist", "modelCount": 5 }
    ],
    "tags": [
      { "name": "dragon", "modelCount": 12 }
    ]
  },
  "meta": null,
  "errors": null
}
```

`data` is a `GlobalSearchResult`. `models.items` contains up to `limit` `ModelCard` objects; `models.total` reflects the full count of matching models regardless of `limit`. `collections`, `artists`, and `tags` each contain up to `limit` hits.

Models are ranked by full-text relevance. Collections are filtered by name substring and sorted by `modelCount` descending. Artists and tags are filtered by name substring, drawn from library-scoped metadata values, and sorted by `modelCount` descending. There is no unified cross-type relevance score.

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
