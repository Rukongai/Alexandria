# Storage

Alexandria stores model files and thumbnails through one storage interface. The default backend is the local filesystem. Setting `STORAGE_BACKEND=s3` selects any compatible S3 service, including AWS S3 and MEGA S4. Database rows contain logical keys such as `models/<model-id>/parts/body.stl`; they do not contain public URLs or provider-specific paths.

Objects should be private. Alexandria's authenticated `/files/...` endpoints look up the logical key and stream bytes through the backend, so browsers never need bucket credentials or direct object access.

## Configuration

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `STORAGE_BACKEND` | `local` | No | `local` or `s3` |
| `STORAGE_PATH` | `./data/storage` | Local; migration source | Local managed-storage root |
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

Alexandria does not currently add client-side object encryption. Any encryption beyond TLS in transit and the storage provider's defaults must be handled outside this adapter.

## Migrate local storage to S3

Migration copies the existing `STORAGE_PATH` tree into the configured S3 bucket and prefix. It never deletes local source files.

1. Stop the backend so no new local objects are written during the copy.
2. Set `STORAGE_BACKEND=s3`, the `S3_*` variables, and credentials. Keep `STORAGE_PATH` pointed at the existing local data.
3. From a source checkout, run:

   ```bash
   npm run storage:migrate -w @alexandria/backend
   ```

   With the published Compose backend image, run the compiled script instead:

   ```bash
   docker compose -f docker/docker-compose.yml run --rm backend \
     node apps/backend/dist/scripts/migrate-storage.js
   ```

4. Review the copied/skipped summary, then start the backend in S3 mode.
5. Verify representative thumbnails, previews, downloads, and a new upload before treating S3 as authoritative.

For every object, the command compares byte size and SHA-256 after upload. If the destination already has a matching object, it reports `skipped`; otherwise it overwrites and verifies it. A verification failure removes the failed destination object and stops the command. Rerun the same command after correcting the problem. Because matching objects are skipped and local files are retained, interrupted migrations are restartable and the prior local backend remains available for rollback.

Do not remove the local volume until backup and rollback requirements have been satisfied.

## Folder imports with remote storage

Server folder imports still read `sourcePath` from a filesystem visible to the backend worker. In S3 mode, Alexandria uploads each file and then reads it back to verify its byte size and SHA-256. The local hardlink/copy/move implementation is not used.

Set `deleteAfterUpload: true` only when the import should remove its source files. Deletion runs after every discovered model completes successfully; any model failure leaves all sources in place. If `deleteAfterUpload` is omitted, it defaults to `true` when the request's legacy `strategy` is `move` and to `false` otherwise. For clarity in automation, set `deleteAfterUpload` explicitly.
