# Local MCP Server

Alexandria includes a local Model Context Protocol server for trusted stdio clients. It runs as a separate process from the Fastify API and does not start the HTTP server, workers, migrations, or seed logic. The server fixes its user and library scope at startup; tool arguments cannot select another account or library.

## Tools

The server exposes exactly seven tools. MCP clients receive the input schemas during tool discovery.

| Tool | Capability |
|---|---|
| `alexandria_search_models` | Searches the configured library using Alexandria's model search parameters, including text, tags, collection, file type, status, metadata filters, sorting, cursor, and page size. Results contain complete raw model table rows rather than presenter-shaped model summaries. |
| `alexandria_get_model` | Returns every column from the owned model row plus its model-file, folder, metadata value and definition, tag and tag-membership, collection and collection-membership, and thumbnail rows. This includes stored information that the web UI does not render. |
| `alexandria_download_model_files` | Downloads all files for an owned model, or the selected `fileIds`, into a required `subdirectory` beneath the configured download root. `overwrite` defaults to `false`. |
| `alexandria_update_model` | Updates core model fields, metadata values keyed by field slug, or both. Core and metadata changes run in one ownership-locked database transaction. |
| `alexandria_merge_models` | Merges one to 100 owned, ready source models into an owned, ready target model. It moves their files and applicable relationships to the target and deletes the source model rows. |
| `alexandria_delete_model` | Deletes one owned model and its database relationships, then attempts best-effort cleanup of every managed file. |
| `alexandria_tag_model` | Adds, removes, or replaces tags on one owned model through Alexandria's metadata normalization and validation. An empty tag list is valid only for `replace`, where it clears the tags. |

Dates in tool results are serialized as ISO 8601 strings and bigint values as strings. `alexandria_search_models` returns raw model rows only; use `alexandria_get_model` when related table rows are required.

## Prerequisites and environment

Install the npm dependencies and ensure Alexandria's database has already been migrated and seeded. The MCP process connects directly to PostgreSQL; it does not perform either setup step. Redis is not required by the MCP process.

Configure the same storage backend that owns the model files. For local storage, `STORAGE_PATH` must resolve to the managed-storage root used by the backend. An absolute path avoids working-directory ambiguity. For S3-compatible storage, set `STORAGE_BACKEND=s3`, `S3_BUCKET`, and any required `S3_ENDPOINT`, `S3_REGION`, `S3_PREFIX`, and `S3_FORCE_PATH_STYLE` values. Supply credentials through the AWS SDK default credential chain, such as `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optionally `AWS_SESSION_TOKEN`.

| Variable | Requirement | Behavior |
|---|---|---|
| `ALEXANDRIA_MCP_USER_ID` | Required | UUID of the Alexandria account the process may act as. |
| `ALEXANDRIA_MCP_LIBRARY_ID` | Optional | UUID of a library owned by that account. When omitted, Alexandria resolves the account's default library. Startup fails if the requested library is not owned by the configured user. |
| `ALEXANDRIA_MCP_DOWNLOAD_DIR` | Optional for server startup; required for downloads | Existing root beneath which `alexandria_download_model_files` may write. Create it with permissions such as `0700` before starting the client and prefer an absolute path. |
| `DATABASE_URL` | Recommended | PostgreSQL connection string for the Alexandria database. If omitted, the MCP entry point constructs a localhost URL from `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_PORT`, and `POSTGRES_DB`, whose MCP defaults are `alexandria`, `alexandria`, `5433`, and `alexandria`. |
| `STORAGE_BACKEND` and provider settings | Required to match the backend | Selects `local` or `s3` and supplies the provider configuration described above. |

The root `.env` file is loaded by the npm script when it exists. Values supplied directly by the MCP client should define the identity scope explicitly and can also provide the database and storage configuration; a client-supplied environment is sufficient when there is no `.env` file.

## Run from the source checkout

From the repository root, start the stdio server with:

```bash
npm --silent run mcp
```

The process waits for MCP JSON-RPC on standard input and writes protocol messages to standard output. Shared Alexandria logging is redirected to standard error so it cannot corrupt the protocol stream. Do not wrap the command with a script that prints status text to standard output.

### Client configuration

Most stdio MCP clients accept a command, argument list, working directory, and environment map. This generic JSON example uses the repository root as the working directory:

```json
{
  "mcpServers": {
    "alexandria": {
      "command": "npm",
      "args": ["--silent", "run", "mcp"],
      "cwd": "/absolute/path/to/Alexandria",
      "env": {
        "ALEXANDRIA_MCP_USER_ID": "00000000-0000-4000-8000-000000000000",
        "ALEXANDRIA_MCP_LIBRARY_ID": "11111111-1111-4111-8111-111111111111",
        "ALEXANDRIA_MCP_DOWNLOAD_DIR": "/absolute/path/to/mcp-downloads",
        "DATABASE_URL": "postgresql://alexandria:password@localhost:5433/alexandria",
        "STORAGE_BACKEND": "local",
        "STORAGE_PATH": "/absolute/path/to/managed-storage"
      }
    }
  }
}
```

For Codex, put the equivalent configuration in `~/.codex/config.toml` or, for a trusted checkout, `.codex/config.toml`:

```toml
[mcp_servers.alexandria]
command = "npm"
args = ["--silent", "run", "mcp"]
cwd = "/absolute/path/to/Alexandria"

[mcp_servers.alexandria.env]
ALEXANDRIA_MCP_USER_ID = "00000000-0000-4000-8000-000000000000"
ALEXANDRIA_MCP_LIBRARY_ID = "11111111-1111-4111-8111-111111111111"
ALEXANDRIA_MCP_DOWNLOAD_DIR = "/absolute/path/to/mcp-downloads"
DATABASE_URL = "postgresql://alexandria:password@localhost:5433/alexandria"
STORAGE_BACKEND = "local"
STORAGE_PATH = "/absolute/path/to/managed-storage"
```

Remove `ALEXANDRIA_MCP_LIBRARY_ID` to use the account's default library. Remove `ALEXANDRIA_MCP_DOWNLOAD_DIR` if downloads should be unavailable. Replace every example UUID, path, and credential; do not use the placeholder values literally.

## Find the scope UUIDs

Choose the user and library scope as the Alexandria operator, not through an untrusted MCP prompt. Query only the identifying columns needed for configuration. With `psql` and `DATABASE_URL` already set:

```bash
psql "$DATABASE_URL" -c '
  SELECT
    u.id AS user_id,
    u.email,
    l.id AS library_id,
    l.name AS library_name,
    l.is_default
  FROM users AS u
  LEFT JOIN libraries AS l ON l.user_id = u.id
  ORDER BY u.email, l.is_default DESC, l.name;
'
```

For the bundled PostgreSQL container, the same read-only query can be run without exposing password hashes or other account data:

```bash
docker compose exec postgres psql \
  -U "${POSTGRES_USER:-alexandria}" \
  -d "${POSTGRES_DB:-alexandria}" \
  -c 'SELECT u.id AS user_id, u.email, l.id AS library_id, l.name AS library_name, l.is_default FROM users AS u LEFT JOIN libraries AS l ON l.user_id = u.id ORDER BY u.email, l.is_default DESC, l.name;'
```

Copy the selected `user_id` into `ALEXANDRIA_MCP_USER_ID`. Either copy an owned `library_id` into `ALEXANDRIA_MCP_LIBRARY_ID` or omit that variable to use the row marked as default.

## Security and destructive behavior

This is a trusted local integration, not a remotely authenticated service. Anyone who can control the stdio client can exercise the configured account's MCP capabilities, including destructive mutations. Protect the client configuration and database or S3 credentials, restrict access to the process, and use the client's tool-approval controls where appropriate.

Every model operation is constrained to the configured user and library. The server verifies ownership and library membership before returning raw related information, downloading files, or mutating data. Missing and out-of-scope identifiers are rejected; tool input cannot override the startup scope.

Search and model inspection are read-only. Downloads write to the local filesystem but do not alter Alexandria records. Update, merge, delete, and tag operations mutate Alexandria data and are advertised to clients as destructive. The server does not add a confirmation step: merge deletes its source models, delete removes the model and attempts managed-file cleanup, tag `replace` discards tags not in the new list, and metadata values set to `null` are removed according to normal Alexandria behavior. There is no MCP undo operation.

### Download containment

Downloads preserve each managed file's relative path beneath the requested subdirectory. Both the tool-supplied subdirectory and stored relative paths must be relative and cannot contain empty, `.` or `..` segments, absolute paths, or control characters. The configured root must already exist; the downloader never creates an unvalidated root. The root and every created component must be owned by the MCP process user and cannot be group- or world-writable. The ancestor chain is also checked for accounts that could replace the root entry; sticky system temporary directories are allowed. Symlinks and non-directory components are rejected. The downloader stages the complete requested file set through private temporary files before promoting any destination, rolls promotions back on failure, and refuses to overwrite existing regular files by default. Setting `overwrite: true` explicitly permits replacement, but existing files are backed up until the complete set has been promoted and symlink destinations are still rejected.

## Docker image

`npm --silent run mcp` is the source-checkout entry point. The `--silent` flag is required because MCP reserves stdout for protocol messages. The production backend image contains the compiled server and can run it with:

```bash
node apps/backend/dist/mcp/server.js
```

Supply the same database, storage, and MCP scope environment as the backend container. Container paths are not automatically visible on the host. If downloads use local storage in a container, set `ALEXANDRIA_MCP_DOWNLOAD_DIR` to a host-visible bind-mounted directory; a path only inside the container is not a usable host download destination.
