# Storage

Alexandria stores model files and thumbnails through one storage interface. The default backend is the local filesystem. Setting `STORAGE_BACKEND=s3` selects any compatible S3 service, including AWS S3 and MEGA S4. Database rows contain logical keys such as `models/<model-id>/parts/body.stl`; they do not contain public URLs or provider-specific paths.

Objects should be private. Alexandria's authenticated `/files/...` endpoints look up the logical key and stream bytes through the backend, so browsers never need bucket credentials or direct object access.

## Derived folder archives

`POST /models/:id/folders/compress` creates a new 7z archive from a folder already stored in a model. It is a non-destructive operation: the source folder and every file below it remain in place, while the new archive is stored beside the folder under the logical key `models/<model-id>/<folder-path>.7z`. Alexandria refuses the operation when that sibling path is already occupied by a file or folder; the action does not replace an existing managed path.

Compression is storage-backend independent. The backend streams the selected files through `StorageService` into a temporary workspace, recreates explicit empty descendant folders, invokes 7-Zip with explicit LZMA2 compression, and stores and verifies the resulting archive through `StorageService`. It does not assume that model files have local filesystem paths, so the same path works with local and S3-compatible storage. Archive entries are relative to the selected folder rather than to the model root. To bound temporary-disk and CPU pressure, each backend process runs at most one folder-compression operation at a time.

After the object is stored, Alexandria creates its `ModelFile` row and updates the model's file count and total size. If persistence fails, it makes a best-effort attempt to remove the newly stored object. Temporary files are removed whether the operation succeeds or fails.

## Configuration

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `STORAGE_BACKEND` | `local` | No | `local` or `s3` |
| `STORAGE_PATH` | `./data/storage` | Local; migration or default S3-cache path | Local managed-storage root and base for the default S3 thumbnail-cache path |
| `STORAGE_UPLOAD_CONCURRENCY` | `8` | No | Files uploaded in parallel to a remote backend; max 32, ignored for local storage |
| `S3_THUMBNAIL_CACHE_MAX_BYTES` | `1073741824` | No | Maximum persistent thumbnail-cache size in bytes; S3 only; `0` disables |
| `S3_THUMBNAIL_CACHE_PATH` | `<STORAGE_PATH>/.cache/s3-thumbnails` | No | Persistent thumbnail-cache directory; S3 only |
| `S3_ENDPOINT` | AWS SDK default | Compatible services | Full custom endpoint URL; omit for AWS S3 |
| `S3_REGION` | `us-east-1` | S3 | Signing region expected by the provider |
| `S3_BUCKET` | — | S3 | Existing bucket name |
| `S3_PREFIX` | empty | No | Optional namespace inside the bucket, without a leading slash |
| `S3_FORCE_PATH_STYLE` | `false` | No | Set `true` when the provider requires path-style bucket URLs |

Alexandria uses the AWS SDK default credential chain. Environment credentials are the simplest option for Docker Compose:

```dotenv
AWS_ACCESS_KEY_ID=example-access-key
AWS_SECRET_ACCESS_KEY=example-secret-key
# AWS_SESSION_TOKEN=example-session-token
```

The standard chain also supports shared AWS configuration and workload credentials such as container or instance roles. In production, prefer a narrowly scoped workload identity or injected secret over credentials committed to a file. The identity needs permission to inspect the bucket and to get, put, copy, inspect, and delete objects beneath `S3_PREFIX`.

The backend runs `HeadBucket` before database migrations and before listening for HTTP traffic. An invalid endpoint, bucket, region, or credential therefore stops startup. `S3_BUCKET` is required when `STORAGE_BACKEND=s3`.

Docker Compose passes the storage and common AWS credential variables into the backend. Its `storagedata` volume remains mounted even in S3 mode so it can serve as the source for migration or a rollback to local storage.

## S3 thumbnail cache

S3 remains the authoritative, private store, and authenticated Fastify routes continue to proxy every response. In S3 mode, Alexandria can keep a bounded persistent local cache for logical keys beneath `thumbnails/`. By default the cache lives at `<STORAGE_PATH>/.cache/s3-thumbnails`; `S3_THUMBNAIL_CACHE_PATH` can place it in a dedicated directory elsewhere. A custom path inside `STORAGE_PATH` must remain beneath that reserved default subtree so migration can never exclude authoritative model or thumbnail objects. It never contains model-file keys and is safe to discard and rebuild.

Thumbnail reads are read-through: a hit is served locally, while a miss retrieves the object from S3 and caches it when possible. Concurrent misses for the same logical key share one S3 retrieval. Before a thumbnail mutation changes S3, the old cache entry is removed; if removal fails, a durable invalidation marker prevents stale bytes from being served across restarts. A mutation is rejected before S3 only when neither action succeeds. Successful buffer stores then populate the cache when possible. Cache files are published atomically and least-recently-used entries are evicted when `S3_THUMBNAIL_CACHE_MAX_BYTES` is exceeded. Other cache filesystem or bookkeeping failures are treated as misses and do not fail S3 reads. The default limit is `1073741824` bytes (1 GiB); set it to `0` to disable the cache.

## Generic S3-compatible example

Provider requirements differ, so Alexandria does not set a provider-specific endpoint by default.

```dotenv
STORAGE_BACKEND=s3
S3_ENDPOINT=https://s3.example.test
S3_REGION=us-east-1
S3_BUCKET=alexandria
S3_PREFIX=production
S3_FORCE_PATH_STYLE=true
AWS_ACCESS_KEY_ID=example-access-key
AWS_SECRET_ACCESS_KEY=example-secret-key
```

Create the bucket before starting Alexandria. The application validates access but does not create buckets.

## MEGA S4

MEGA S4 uses regional endpoints with the pattern `https://s3.<region>.megas4.com`. For example, Amsterdam currently uses `https://s3.eu-amsterdam.megas4.com` with region `eu-amsterdam`:

```dotenv
STORAGE_BACKEND=s3
S3_ENDPOINT=https://s3.eu-amsterdam.megas4.com
S3_REGION=eu-amsterdam
S3_BUCKET=alexandria
S3_PREFIX=
S3_FORCE_PATH_STYLE=false
AWS_ACCESS_KEY_ID=your-s4-access-key
AWS_SECRET_ACCESS_KEY=your-s4-secret-key
```

Endpoint availability can change; select the closest current endpoint from MEGA's [official S4 endpoint list](https://help.mega.io/megas4/setup-guides/mega-s4-endpoint-urls) or from the S4 settings in the MEGA web client. The example is illustrative and is not an Alexandria default.

MEGA S4 rejects several optional headers commonly accepted by AWS S3. Alexandria configures the AWS SDK's request and response checksum modes as `WHEN_REQUIRED` and does not send server-side-encryption, ACL, or non-standard storage-class headers. Configure access controls and any supported provider-side data protections outside Alexandria rather than adding those headers to uploads.

MEGA S4 exposes no client library of its own; it is reached through the standard S3 SDK. MEGA's own SDK and MEGAJS target the consumer cloud drive, which is a different product with a different protocol, and do not apply here.

Alexandria does not currently add client-side object encryption. Any encryption beyond TLS in transit and the storage provider's defaults must be handled outside this adapter.

## Upload throughput and verification

A remote object store charges a fixed round trip per request, and that cost dominates the many small files in a typical model — thumbnails especially, which are tens of kilobytes each. Alexandria therefore uploads several files at once rather than one at a time, bounded by `STORAGE_UPLOAD_CONCURRENCY`. Individual files larger than the 8 MiB part size are additionally uploaded as concurrent multipart parts by the AWS SDK. Local storage stays sequential, since filesystem writes gain nothing from fan-out.

The socket pool is sized from `STORAGE_UPLOAD_CONCURRENCY` so it cannot become the real limit; raising the setting raises the pool with it. Values above 16 showed no reliable benefit in testing against MEGA S4, and the ceiling is 32.

Uploads are verified without reading the object back. Each file is hashed as it streams to the provider, producing both its SHA-256 and the ETag those bytes should yield; the SHA-256 is checked against the hash recorded when the file was scanned, and the ETag against what the provider reports. Objects larger than the single-request copy limit are duplicated with a server-side multipart copy, so their bytes never travel through the backend. Together these mean an import or migration moves each byte once rather than twice.

ETag verification assumes the provider follows the standard S3 scheme — MD5 for a single-request upload, and the MD5 of concatenated part digests with a `-<partCount>` suffix for a multipart upload. This was confirmed against MEGA S4. A provider that returns some other ETag format is treated as offering no verification rather than as failing it, and the SHA-256 check still applies.

## Migrate local storage to S3

Migration copies the authoritative objects in the existing `STORAGE_PATH` tree into the configured S3 bucket and prefix. It never deletes local source files. The reserved thumbnail-cache directory is excluded from enumeration because its contents are rebuildable copies, not migration or rollback sources.

1. Stop the backend so no new local objects are written during the copy.
2. Set `STORAGE_BACKEND=s3`, the `S3_*` variables, and credentials. Keep `STORAGE_PATH` pointed at the existing local data. The migration script does not load the repository's `.env` automatically, so export those values into the shell first. For example, from the repository root:

   ```bash
   set -a
   source .env
   set +a
   ```

3. From the same shell in a source checkout, run:

   ```bash
   npm run storage:migrate -w @alexandria/backend
   ```

   With the published Compose backend image, run the compiled script instead:

   ```bash
   docker compose run --rm backend \
     node apps/backend/dist/scripts/migrate-storage.js
   ```

4. Review the copied/skipped summary, then start the backend in S3 mode.
5. Verify representative thumbnails, previews, downloads, and a new upload before treating S3 as authoritative.

For every object, the command compares byte size and SHA-256 after upload. If the destination already has a matching object, it reports `skipped`; otherwise it overwrites and verifies it. A verification failure removes the failed destination object and stops the command. Rerun the same command after correcting the problem. Because matching objects are skipped and local files are retained, interrupted migrations are restartable and the prior local backend remains available for rollback.

Do not remove the local volume until backup and rollback requirements have been satisfied.

## Folder imports with remote storage

Server folder imports still read `sourcePath` from a filesystem visible to the backend worker. In S3 mode, Alexandria uploads each file and then reads it back to verify its byte size and SHA-256. The local hardlink/copy/move implementation is not used.

Set `deleteAfterUpload: true` only when the import should remove its source files. Deletion runs after every discovered model completes successfully; any model failure leaves all sources in place. Immediately before deletion, Alexandria hashes the source again and retains it if its size or SHA-256 changed since upload. Individual deletion failures are logged and retained without retrying the already-completed import, preventing duplicate models after a partial deletion pass. If `deleteAfterUpload` is omitted, it defaults to `true` when the request's legacy `strategy` is `move` and to `false` otherwise. For clarity in automation, set `deleteAfterUpload` explicitly.
