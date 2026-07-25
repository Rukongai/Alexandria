# Alexandria — Codex Instructions

Self-hosted personal library for 3D-printing model collections. npm workspaces + Turborepo.

| Workspace | What it is |
|-----------|-----------|
| `apps/backend` | Fastify + TypeScript. Drizzle/Postgres, BullMQ workers on Redis, services under `src/services/`, thin routes under `src/routes/` |
| `apps/frontend` | React + Vite + Tailwind + shadcn/ui |
| `packages/shared` | Canonical types, Zod validation schemas, shared constants |
| `tools/telegram-importer` | Standalone Python CLI, not part of the npm workspace |

---

## Commands

Run everything through npm/turbo from the repo root:

```
npm run dev:up      # infra + migrate + seed + both dev servers (one command)
npm run dev         # dev servers only, infra already running
npm run services:up # Postgres + Redis only (needed for integration tests)
npm test            # all tests
npm run lint
npm run build
```

Single workspace: `npm test -w @alexandria/backend` (or `@alexandria/frontend`).

**Do not run `npx vitest` from the repo root.** There is no root `vitest.config.*`, so a root
invocation runs frontend tests without `jsdom` and without `src/test/setup.ts`, and drops the
backend's `fileParallelism: false` / single-fork settings that the shared-DB integration tests
depend on. Always go through `npm test`.

Backend tests need Postgres and Redis running (`npm run services:up`). Do **not** export
`DATABASE_URL` for them — `apps/backend/vitest.config.ts` pins the test DB to
`postgresql://alexandria:alexandria@localhost:5433/alexandria_test`, and overriding it points
the suite at the dev database.

---

## Gotchas

**Drizzle migrations are hand-authored.** `db:generate` is not the working path — meta snapshots
stopped being produced long ago and the generator can't resolve the schema's `.js` ESM imports.
To add a migration: write the `.sql` file in `apps/backend/src/db/migrations/`, add a matching
entry to `meta/_journal.json` (`idx`, `tag`, `when`), then apply with `db:migrate`.

**A migration with a too-low `when` is silently skipped.** The migrator only applies entries whose
`when` exceeds the newest already-applied timestamp, and entry `0008` was authored out of order,
so the bar is higher than wall-clock time. Set each new `when` above the current maximum in
`_journal.json` (currently `1784771953000`). "Migrations complete" prints either way — verify the
table or column actually exists afterwards.

**Two databases exist** on `localhost:5433`: `alexandria` (dev) and `alexandria_test` (vitest).
A schema change must be migrated into both, or integration tests run against a stale schema:
`DATABASE_URL=…/alexandria_test npm run db:migrate -w @alexandria/backend`.

---

## Git Workflow (MANDATORY)

**Never commit directly to `main`.** Every task uses a branch and a PR. **Never self-merge** —
leave PRs open for review.

| Type | Branch format |
|------|--------|
| Bug fix with issue | `fix/{issue-number}-{short-slug}` |
| Feature with issue | `feat/{issue-number}-{short-slug}` |
| Bug fix without issue | `fix/{short-slug}` |
| Feature without issue | `feat/{short-slug}` |

```
git checkout main && git pull
git checkout -b fix/<number>-<slug>   # or feat/
# ... do work ...
git add <files>
git commit -m "fix: ..."
gh pr create --title "..." --body "..."   # include "Closes #<number>" when there's an issue
```

Commit messages are conventional commits — `<type>: <description>`, with an optional `(<scope>)`.
Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `build`.

---

## Docs — Look Up, Don't Preload

These are references, not required reading. Open the section you need; don't load whole files
speculatively (`API.md` alone is ~2,400 lines).

| Doc | Go here for |
|-----|-------------|
| `docs/ARCHITECTURE.md` | Service boundaries, startup sequence, component map, decision log. The source of truth for structure — read the relevant section before any structural change |
| `docs/CONVENTIONS.md` | Naming, route/service patterns, error handling, logging, storage paths, testing style |
| `docs/TYPES.md` | Canonical type definitions — read before changing an API contract or shared type |
| `docs/API.md` | Endpoint reference — read the specific endpoints you're touching |
| `docs/STORAGE.md` | Local vs S3-compatible storage, path layout, migration |
| `docs/DEPLOYMENT.md`, `docs/HOSTED_DATABASE.md` | Docker Compose deployment, hosted Postgres |

If something doesn't fit the architecture, don't improvise — propose a specific update to
`docs/ARCHITECTURE.md` with rationale, make it an explicit change, then implement against it.

`docs/PLAN.md` and `docs/AGENTS.md` describe the original phased build-out and are historical.
Don't take process direction from them.

Never speculate about code you haven't opened. If a file is referenced, read it first.

---

## Subagents

Delegate for **substantial, scoped work** — a whole feature layer, a new service, a broad review —
where an isolated context window genuinely helps. Work directly on small changes, single-file
edits, and anything spanning several domains at once; a cold subagent re-derives context you
already have and usually costs more than it returns.

| Area | Agent |
|------|-------|
| React pages / components / hooks / API client | `frontend` |
| Fastify routes / services / middleware / workers | `backend-service` |
| Schema / migrations / query optimization | `database` |
| Test coverage | `testing` |
| Architectural drift and convention review | `reviewer` |
| Doc updates after a feature lands | `documentation` |

When delegating, hand over only the relevant architecture section, types, and source files.

Run `reviewer` once at the end of a feature or a non-trivial fix, after implementation, tests, and
documentation are stable — not for a typo or a one-line change. Treat its findings as one
consolidated correction pass; do not automatically run another full review after every fix.
Request at most one targeted follow-up review only when the correction materially changes a
security boundary, concurrency behavior, data integrity, architecture, or a public type/API
contract, or when the reviewer explicitly could not validate the original issue without it.

Run `documentation` once, after endpoint, type-contract, or architecture changes have settled.

---

## Validation Scope

Run the narrowest checks that cover the behavior changed by the task:

- **Documentation-only changes**, including a merge conflict resolved only in Markdown: inspect
  the combined text and run `git diff --check`. Run a documentation-specific checker if one
  exists. Do **not** run `npm test`, `npm run lint`, or `npm run build` unless the edited document
  is generated or validated by one of those commands.
- **One workspace:** run that workspace's relevant tests. Add its build/typecheck when production
  compilation or a TypeScript contract can be affected.
- **Shared contracts, multiple workspaces, migrations, configuration, or broad source changes:**
  run `npm test`; add `npm run lint` and `npm run build` when the change can affect those surfaces.
- **Merging `main` into a task branch:** validate the conflict resolution and the task branch's
  combined behavior. Incoming, already-reviewed code from `main` does not by itself require a full
  repository test/build. Broaden validation only when conflicts or cross-branch interactions touch
  source, configuration, dependencies, generated artifacts, migrations, or shared contracts.

Passing CI on `main` is evidence for unchanged incoming code, not a reason to repeat every local
check after a documentation-only conflict.

---

## Task Flow

1. If there's an issue: `gh issue view <number>`
2. Branch from up-to-date `main`
3. Read the relevant source and the doc sections that cover it
4. Implement — directly, or delegated per the table above
5. Validate according to **Validation Scope** above
6. Run `reviewer` and `documentation` only at the thresholds described above
7. `gh pr create`, with `Closes #<number>` when an issue exists

---

## Slash Commands

| Command | Purpose |
|---------|---------|
| `/new-bug-issue` | Interactively create a new bug GitHub issue |
| `/new-feature-issue` | Interactively create a new feature GitHub issue |
| `/work-on-issue [number]` | Fetch an issue, create the correct branch, and load relevant docs |
