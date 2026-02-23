# Alexandria — Claude Code Instructions

## Git Workflow (MANDATORY)

**Never commit directly to `main`.** Every task (bug fix, feature, refactor) must use a branch and a PR.

### Branch Naming

| Type | Format |
|------|--------|
| Bug fix with issue | `fix/{issue-number}-{short-slug}` |
| Feature with issue | `feat/{issue-number}-{short-slug}` |
| Bug fix without issue | `fix/{short-slug}` |
| Feature without issue | `feat/{short-slug}` |

### Standard Task Flow

```
git checkout main && git pull
git checkout -b fix/<number>-<slug>   # or feat/
# ... do work ...
git add <files>
git commit -m "fix: ..."              # conventional commit format
gh pr create --title "..." --body "..."
```

### Commit Format

Follow `docs/CONVENTIONS.md` for conventional commit messages:
- `fix: ...` for bug fixes
- `feat: ...` for new features
- `refactor: ...` for internal changes
- `test: ...` for test-only changes
- `docs: ...` for documentation

**Never self-merge.** Leave PRs open for review.

---

## Before Starting Any Task — Load These Docs

| Doc | When to load |
|-----|-------------|
| `docs/ARCHITECTURE.md` | Every task |
| `docs/CONVENTIONS.md` | Every task |
| `docs/TYPES.md` | When touching API contracts or shared types |
| `docs/API.md` | When adding or modifying endpoints |
| `docs/AGENTS.md` | When delegating to sub-agents |

---

## Working on a Bug

### Doc Checklist
1. `docs/ARCHITECTURE.md` — locate the service boundary where the bug lives
2. `docs/CONVENTIONS.md` — confirm correct patterns before writing fixes
3. `docs/TYPES.md` — verify type contracts aren't violated by the fix

### Agent Delegation Matrix

| Area | Agent |
|------|-------|
| React component / hook / page / API client | `frontend` |
| Fastify route / service / middleware / worker | `backend-service` |
| DB schema / migration / query | `database` |
| Test coverage | `testing` |
| Review (always run at end) | `reviewer` |
| Cross-cutting (spans multiple domains) | Work directly; delegate sub-tasks |

### Bug Fix Process
1. Fetch issue: `gh issue view <number>`
2. Create branch: `git checkout main && git pull && git checkout -b fix/<number>-<slug>`
3. Read relevant source files (don't guess — read first)
4. Delegate to the appropriate domain agent, or work directly for cross-cutting changes
5. Run tests: `npx vitest run` (with `DATABASE_URL` if integration tests)
6. Invoke `reviewer` agent
7. Create PR: `gh pr create` with `Closes #<number>` in the body

---

## Working on a Feature

### Doc Checklist
1. `docs/ARCHITECTURE.md` — understand service boundaries and where the feature fits
2. `docs/TYPES.md` — identify new or changed types, update shared types first
3. `docs/CONVENTIONS.md` — confirm correct patterns before writing new code
4. `docs/API.md` — review endpoint contracts; update for any new endpoints

### Agent Delegation Matrix

| Area | Agent |
|------|-------|
| React pages / components / hooks | `frontend` |
| Backend services / routes / workers | `backend-service` |
| DB columns / tables / migrations | `database` |
| Multi-domain feature | Delegate each domain; coordinate from main session |
| Tests | `testing` |
| Review (always run at end) | `reviewer` |
| Docs update (always run at end) | `documentation` |

### Feature Process
1. Fetch issue: `gh issue view <number>`
2. Create branch: `git checkout main && git pull && git checkout -b feat/<number>-<slug>`
3. Check if `docs/ARCHITECTURE.md` needs an update before writing code
4. Delegate to domain agents for each layer (database → backend → frontend)
5. Coordinate results and resolve any cross-layer dependencies
6. Run tests
7. Invoke `reviewer` agent
8. Invoke `documentation` agent to update `docs/API.md`, `docs/ARCHITECTURE.md`, etc.
9. Create PR with `Closes #<number>` in the body

---

## Slash Commands

| Command | Purpose |
|---------|---------|
| `/new-bug-issue` | Interactively create a new bug GitHub issue |
| `/new-feature-issue` | Interactively create a new feature GitHub issue |
| `/work-on-issue [number]` | Fetch an issue, create the correct branch, and load relevant docs |
