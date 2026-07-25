# Alexandria metadata.json Prefill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an uploaded archive contains `metadata.json` at its root, detect it during the scan phase and surface it on the import session so the review form prefills.

**Architecture:** Purely additive to the existing scan-phase detection. `IngestionService.detectImportMetadata` gains a root-directory parameter, reads `metadata.json` from the extracted tree, validates it leniently against the existing `batchUploadMetadataSchema`, and stores the result on `DetectedImportMetadata.metadataFile`. **Never auto-applied at commit** — the client always sends the metadata it intends, so this change cannot alter the outcome of any existing upload path.

**Tech Stack:** Fastify, TypeScript, Drizzle, Zod, Vitest; React + Vite frontend.

**Spec:** `docs/superpowers/specs/2026-07-25-telegram-staged-import-design.md` §5

**Relationship to the importer plan:** Independent. `docs/superpowers/plans/2026-07-25-telegram-staged-import.md` does not depend on this, because the importer sends `batchMetadata` explicitly at commit — which is what lets an upload-as-is `.7z`, whose bytes the backend cannot modify, still carry its metadata. This plan is what makes a hand-made zip dropped into the web UI prefill too.

**Conventions in this codebase you must follow:**
- Run tests with `npm test -w @alexandria/backend`; backend tests need `npm run services:up` first.
- Do **not** export `DATABASE_URL` — `apps/backend/vitest.config.ts` pins the test database.
- Do **not** run `npx vitest` from the repo root.
- Never commit to `main`; this plan's work belongs on its own branch and PR.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/types/upload.ts` (modify) | `DetectedMetadataFile` type, `metadataFile` field on `DetectedImportMetadata` |
| `packages/shared/src/validation/upload.ts` (modify) | `metadataFileSchema` — lenient parse of an archive's `metadata.json` |
| `apps/backend/src/services/ingestion.service.ts` (modify) | Read and validate `metadata.json` during detection |
| `apps/backend/src/services/ingestion.service.test.ts` (modify) | Detection tests |
| `apps/frontend/…` review form (modify) | Prefill empty fields from `detected.metadataFile` |
| `docs/TYPES.md`, `docs/API.md` (modify) | Document the new field |

---

## Task 1: Shared type and lenient schema

**Files:**
- Modify: `packages/shared/src/types/upload.ts`
- Modify: `packages/shared/src/validation/upload.ts`
- Test: `packages/shared/src/validation/upload.test.ts` (create if absent)

- [ ] **Step 1: Write the failing tests**

Create or append to `packages/shared/src/validation/upload.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { metadataFileSchema } from './upload.js';

describe('metadataFileSchema', () => {
  it('should keep known commit fields', () => {
    const result = metadataFileSchema.safeParse({
      modelName: 'Dragon Knight',
      description: 'A dragon',
      artist: 'Foo Studios',
      tags: ['dragon', 'fantasy'],
      metadata: { scale: '32mm' },
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      modelName: 'Dragon Knight',
      description: 'A dragon',
      artist: 'Foo Studios',
      tags: ['dragon', 'fantasy'],
      metadata: { scale: '32mm' },
    });
  });

  it('should strip keys the commit endpoint does not accept', () => {
    const result = metadataFileSchema.safeParse({
      modelName: 'Dragon',
      schemaVersion: 1,
      source: { channelId: -100 },
      result: { modelId: 'abc' },
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ modelName: 'Dragon' });
  });

  it('should drop individually invalid fields rather than rejecting the file', () => {
    const result = metadataFileSchema.safeParse({
      modelName: 'Dragon',
      tags: 'not-an-array',
      artist: 12345,
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ modelName: 'Dragon' });
  });

  it('should reject a non-object root', () => {
    expect(metadataFileSchema.safeParse([1, 2]).success).toBe(false);
    expect(metadataFileSchema.safeParse('nope').success).toBe(false);
  });

  it('should accept an empty object', () => {
    const result = metadataFileSchema.safeParse({});

    expect(result.success).toBe(true);
    expect(result.data).toEqual({});
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @alexandria/shared`
Expected: FAIL — `metadataFileSchema` is not exported

- [ ] **Step 3: Add the type**

In `packages/shared/src/types/upload.ts`, add above `DetectedImportMetadata`:

```typescript
/**
 * A `metadata.json` found at the root of an uploaded archive. Prefill only —
 * never applied automatically at commit. The client always sends the metadata
 * it intends, so detection cannot change an upload's outcome.
 */
export type DetectedMetadataFile = Pick<
  BatchUploadMetadata,
  'modelName' | 'description' | 'artist' | 'tags' | 'metadata' | 'collectionId' | 'newCollectionName'
>;
```

Add this field to the `DetectedImportMetadata` interface, immediately after `archives`:

```typescript
  /** Parsed root-level metadata.json, when the archive carried one. */
  metadataFile?: DetectedMetadataFile;
```

Verify `BatchUploadMetadata` is already imported or defined in that file; if it lives in the validation module, import the type.

- [ ] **Step 4: Add the schema**

In `packages/shared/src/validation/upload.ts`, add after `batchUploadMetadataSchema`:

```typescript
/**
 * Lenient parse of an archive's metadata.json. Every field is independently
 * optional and catches to undefined, so one malformed value never costs the
 * operator the rest of a hand-written file.
 */
export const metadataFileSchema = z.object({
  modelName: z.string().min(1).max(255).optional().catch(undefined),
  description: z.string().max(2000).optional().catch(undefined),
  artist: z.string().max(255).optional().catch(undefined),
  tags: z.array(z.string().min(1).max(100)).max(50).optional().catch(undefined),
  metadata: setModelMetadataSchema.optional().catch(undefined),
  collectionId: z.string().uuid().optional().catch(undefined),
  newCollectionName: z.string().min(1).max(255).optional().catch(undefined),
}).strip();

export type DetectedMetadataFileInput = z.infer<typeof metadataFileSchema>;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w @alexandria/shared`
Expected: PASS, 5 tests

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types/upload.ts packages/shared/src/validation/upload.ts packages/shared/src/validation/upload.test.ts
git commit -m "feat: add a lenient schema for archive metadata.json prefill"
```

---

## Task 2: Detect metadata.json during the scan

**Files:**
- Modify: `apps/backend/src/services/ingestion.service.ts`
- Test: `apps/backend/src/services/ingestion.service.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/backend/src/services/ingestion.service.test.ts`. Match the file's existing import and setup style — read its first 40 lines before writing.

```typescript
describe('metadata.json detection', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'alexandria-metadata-'));
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  async function writeMetadata(contents: string): Promise<void> {
    await fsPromises.writeFile(path.join(rootDir, 'metadata.json'), contents, 'utf8');
  }

  it('should surface a valid root metadata.json', async () => {
    await writeMetadata(JSON.stringify({ modelName: 'Dragon', tags: ['dragon'] }));

    const detected = await readMetadataFile(rootDir);

    expect(detected).toEqual({ modelName: 'Dragon', tags: ['dragon'] });
  });

  it('should strip importer-only keys', async () => {
    await writeMetadata(
      JSON.stringify({ modelName: 'Dragon', schemaVersion: 1, source: { channelId: -1 } }),
    );

    expect(await readMetadataFile(rootDir)).toEqual({ modelName: 'Dragon' });
  });

  it('should return undefined when the file is absent', async () => {
    expect(await readMetadataFile(rootDir)).toBeUndefined();
  });

  it('should return undefined for unparseable JSON', async () => {
    await writeMetadata('{not json');

    expect(await readMetadataFile(rootDir)).toBeUndefined();
  });

  it('should return undefined for a non-object root', async () => {
    await writeMetadata('[1, 2, 3]');

    expect(await readMetadataFile(rootDir)).toBeUndefined();
  });

  it('should return undefined for a file over the size cap', async () => {
    await writeMetadata(JSON.stringify({ description: 'x'.repeat(70 * 1024) }));

    expect(await readMetadataFile(rootDir)).toBeUndefined();
  });

  it('should ignore a metadata.json nested below the archive root', async () => {
    await fsPromises.mkdir(path.join(rootDir, 'inner'), { recursive: true });
    await fsPromises.writeFile(
      path.join(rootDir, 'inner', 'metadata.json'),
      JSON.stringify({ modelName: 'Nested' }),
      'utf8',
    );

    expect(await readMetadataFile(rootDir)).toBeUndefined();
  });

  it('should return an empty object for a file with no usable fields', async () => {
    await writeMetadata(JSON.stringify({ source: { channelId: -1 } }));

    expect(await readMetadataFile(rootDir)).toEqual({});
  });
});
```

Import `readMetadataFile` from the service module, plus `fsPromises`, `path`, and `os`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run services:up` then `npm test -w @alexandria/backend -- ingestion.service`
Expected: FAIL — `readMetadataFile` is not exported

- [ ] **Step 3: Write the implementation**

In `apps/backend/src/services/ingestion.service.ts`, add near the other module-level constants:

```typescript
const METADATA_FILENAME = 'metadata.json';
const MAX_METADATA_FILE_BYTES = 64 * 1024;
```

Import `metadataFileSchema` and the `DetectedMetadataFile` type from `@alexandria/shared`.

Add this exported function at module level (not a class method — it is pure and directly testable):

```typescript
/**
 * Read an archive root's metadata.json for review-form prefill.
 *
 * Best-effort by design: an unreadable, oversized, or malformed file is
 * skipped rather than failing the scan, because detection must never be able
 * to break an upload that would otherwise have succeeded.
 */
export async function readMetadataFile(
  rootDir: string,
): Promise<DetectedMetadataFile | undefined> {
  const filePath = path.join(rootDir, METADATA_FILENAME);
  try {
    const stats = await fsPromises.stat(filePath);
    if (!stats.isFile() || stats.size > MAX_METADATA_FILE_BYTES) return undefined;
    const parsed: unknown = JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const result = metadataFileSchema.safeParse(parsed);
    if (!result.success) return undefined;
    return Object.fromEntries(
      Object.entries(result.data).filter(([, value]) => value !== undefined),
    ) as DetectedMetadataFile;
  } catch {
    return undefined;
  }
}
```

Change `detectImportMetadata`'s signature to accept the root directory:

```typescript
  private async detectImportMetadata(
    manifest: FileManifest,
    originalFilename: string,
    libraryId: string,
    rootDir: string,
  ): Promise<DetectedImportMetadata> {
```

Inside it, change the `Promise.all` to also read the file, and add the field to the returned object:

```typescript
    const [artist, tagsGuessed, metadataFile] = await Promise.all([
      this.guessArtist(entries, originalFilename, libraryId),
      this.guessTags(entries, libraryId),
      readMetadataFile(rootDir),
    ]);
```

```typescript
      archives: entries
        .filter((entry) => Boolean(detectArchiveExtension(entry.filename)))
        .map((entry) => ({
          filename: entry.filename,
          relativePath: entry.relativePath,
          sizeBytes: entry.sizeBytes,
        })),
      ...(metadataFile ? { metadataFile } : {}),
    };
```

Update all three call sites to pass the root they already have in scope:
- Line ~226 in `processScanJob` → pass `extractDir`
- Line ~310 → pass `stagingRoot`
- Line ~378 → pass `stagingRoot`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @alexandria/backend -- ingestion.service`
Expected: PASS, including the 8 new tests and every pre-existing one

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/services/ingestion.service.ts apps/backend/src/services/ingestion.service.test.ts
git commit -m "feat: detect a root metadata.json during import scanning"
```

---

## Task 3: Prefill the review form

**Files:**
- Modify: the import review form under `apps/frontend/src`

- [ ] **Step 1: Locate the review form**

Run: `grep -rln "tagsGuessed\|detected\." apps/frontend/src`

The component consuming `detected.artist` and `detected.tagsGuessed` for the commit form is the one to change. Read it fully before editing.

- [ ] **Step 2: Write the failing test**

Follow the test style already used beside that component. The test must assert:

- Given a session whose `detected.metadataFile` is `{ modelName: 'Dragon', artist: 'Foo', tags: ['dragon'] }`, the form's name, artist, and tags inputs are populated with those values on first render.
- Given a `metadataFile` **and** a user-entered value, the user's value wins — prefill never overwrites input the user has already made.
- Given `metadataFile` absent, behavior is exactly as before this change (existing tests must cover this; if none does, add one).

Run the test and confirm it fails before implementing.

- [ ] **Step 3: Implement the prefill**

Apply `detected.metadataFile` values as the initial form state, taking precedence over `detected.artist` / `detected.tagsGuessed` (an explicit file beats a heuristic guess) but never over state the user has already changed.

- [ ] **Step 4: Run the frontend suite**

Run: `npm test -w @alexandria/frontend`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src
git commit -m "feat: prefill the import review form from a detected metadata.json"
```

---

## Task 4: Documentation

**Files:**
- Modify: `docs/TYPES.md`, `docs/API.md`

- [ ] **Step 1: Update the docs**

In `docs/TYPES.md`, document `DetectedMetadataFile` and the `metadataFile` field on `DetectedImportMetadata`, stating that it is prefill only and never auto-applied at commit.

In `docs/API.md`, update the import-session response documentation for `GET /models/import-sessions/{id}` to include `detected.metadataFile`, with a note on the 64 KB cap, root-only lookup, and best-effort parsing.

Per `CLAUDE.md`, run the `documentation` agent for this task — the change alters a type contract and an endpoint response.

- [ ] **Step 2: Commit**

```bash
git add docs/TYPES.md docs/API.md
git commit -m "docs: document detected metadata.json prefill"
```

---

## Task 5: Full verification and PR

- [ ] **Step 1: Run everything**

```bash
npm test
npm run lint
npm run build
```

Expected: all pass.

- [ ] **Step 2: Verify the commit path is genuinely unchanged**

Run: `npm test -w @alexandria/backend -- upload.service import-session.service`
Expected: PASS with no assertion changes. A commit with no `batchMetadata` must still produce a model with no metadata applied — detection must not have leaked into `applyBatchMetadata`. If any of those assertions needed changing, the prefill-only guarantee was broken; stop and report it.

- [ ] **Step 3: Run the reviewer agent**

Per `CLAUDE.md`, run the `reviewer` agent over the diff.

- [ ] **Step 4: Open the PR**

```bash
gh pr create --title "feat: prefill import review from a metadata.json in the archive" --body "..."
```

The body must state the prefill-only guarantee and that no existing upload path changes behavior. Do not merge.

---

## Self-Review Notes

Checked against spec §5:

- Lenient validation against `batchUploadMetadataSchema` with unknown keys stripped → Task 1.
- Invalid JSON, non-object root, >64 KB skipped with no scan failure → Task 2.
- Surfaced as an optional field on `detected`, added to `packages/shared` → Tasks 1, 2.
- Documented in `docs/TYPES.md` and `docs/API.md` → Task 4.
- Frontend prefills empty fields → Task 3.
- Never auto-applied at commit → guaranteed by construction (nothing in this plan touches `applyBatchMetadata`) and verified explicitly in Task 5 Step 2.

Tasks 3 and 4 intentionally specify assertions and required content rather than literal code: the frontend component and doc sections must be read before editing, and inventing their current contents here would produce edits that do not apply. Every backend and shared-package change — where the existing code was read directly — carries complete code.
