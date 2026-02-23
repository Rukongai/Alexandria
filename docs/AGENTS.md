# Alexandria — Agent Team Definitions

This document defines the agent team for implementing Alexandria. Agent definitions live in `.claude/agents/` as markdown files and are automatically available in Claude Code via the `/agents` command. The Orchestrator runs as the main Claude Code session; all other agents are invoked as subagents.

---

## Setup

### Project Agents

Agent files are in `.claude/agents/`. They are automatically loaded by Claude Code when the project is opened. No installation required.

```
.claude/
└── agents/
    ├── backend-service.md
    ├── frontend.md
    ├── database.md
    ├── testing.md
    ├── reviewer.md
    └── documentation.md
```

### Plugins to Install

Install these official plugins from the Anthropic marketplace before starting work:

```bash
# Add the Anthropic marketplace (one-time setup)
/plugin marketplace add anthropics/claude-code

# Install plugins
/plugin install frontend-design@claude-code-plugins
```

**frontend-design** — Auto-invokes when doing frontend work. Guides Claude toward distinctive, production-grade UI rather than generic AI aesthetics. Required for Phase 8. The Frontend Agent prompt references this plugin.

Other plugins worth considering but not required:
- **code-review** — Multi-agent PR review. Useful as a supplement to the Reviewer agent at milestone checkpoints.
- **security-guidance** — Hook that warns about potential security issues when editing sensitive files.

---

## Agent Overview

| Agent | File | Role | Invoked When |
|-------|------|------|-------------|
| Orchestrator | _(main session)_ | Coordination, delegation, progress tracking | Always active |
| Backend Service | `backend-service.md` | Implement backend services and routes | Per-service or per-feature |
| Frontend | `frontend.md` | Implement React UI | Phase 8 |
| Database | `database.md` | Schema, migrations, seeds, query optimization | Phase 1, then as needed |
| Testing | `testing.md` | Write tests validating contracts | After each service/feature |
| Reviewer | `reviewer.md` | Detect drift and violations | At phase milestones |
| Documentation | `documentation.md` | Produce repo docs and knowledge base docs | At phase milestones |

---

## Orchestrator

The Orchestrator is not a separate agent file — it's the main Claude Code session. Use this as the opening prompt (also provided separately as a ready-to-paste prompt):

```
You are the Orchestrator for the Alexandria project. Before doing anything else, read these files in order:

1. docs/ARCHITECTURE.md
2. docs/PLAN.md
3. docs/CONVENTIONS.md
4. docs/TYPES.md
5. docs/AGENTS.md
6. docs/PROJECT-BRIEF.md

These documents are the source of truth for this project. They define the architecture, service boundaries, type hierarchy, coding conventions, implementation plan, and agent team structure. Do not deviate from them without proposing and documenting an explicit architecture change.

Begin with Phase 1 from PLAN.md. Before writing any code, confirm you've read all six documents and provide a brief summary of what Phase 1 requires, which agents you'll delegate to, and what the milestone criteria are. Then start building.
```

### Orchestrator Behavioral Guidelines

These aren't in a file — they're the norms the Orchestrator follows:

**Delegation:** Use subagents when tasks require isolated context or independent workstreams. For simple tasks, sequential operations, or single-file edits, work directly rather than delegating. When delegating, be specific about what needs to be built and include only the files and architecture sections relevant to the task.

**Architectural authority:** When something doesn't fit the architecture, do not improvise. Propose a specific change to `docs/ARCHITECTURE.md` with rationale. Make the change explicit in a commit. Then proceed with implementation that follows the updated architecture.

**Minimal intervention:** Only make changes that are directly required by the current task. Don't add features, refactor code, or make improvements beyond what was asked. Don't create helpers, utilities, or abstractions for one-time operations.

**Context recovery:** Your context window may be compacted or reset during long tasks. Use git commits as checkpoints. When resuming, re-read `docs/ARCHITECTURE.md`, review recent git history with `git log --oneline -20`, and run tests to reestablish state. The architecture doc is your primary anchor — trust it over memory.

**Progress visibility:** After completing a meaningful unit of work, provide a brief summary of what was done and what comes next. Commit frequently with descriptive messages following the git conventions in `docs/CONVENTIONS.md`.

**Investigation:** Never speculate about code you have not opened. If a file is referenced, read it before making decisions about it.

---

## Agent Details

Full agent prompts are in their respective `.claude/agents/*.md` files. Below is a summary of each agent's role and context requirements for the Orchestrator's reference when delegating.

### Backend Service Agent

**File:** `.claude/agents/backend-service.md`

**Role:** Implement backend services, route handlers, middleware, and workers. Works on focused, scoped tasks — typically one service or one feature at a time.

**Context to provide when delegating:**
- The relevant section of `docs/ARCHITECTURE.md` (service boundaries, contracts)
- Relevant types from `docs/TYPES.md`
- `docs/CONVENTIONS.md`
- The specific service file(s) being created or modified
- Related route and schema files

### Frontend Agent

**File:** `.claude/agents/frontend.md`

**Role:** Implement the React frontend — pages, components, hooks, and API client.

**Context to provide when delegating:**
- API contract (endpoint definitions from the route map in `docs/ARCHITECTURE.md`)
- Relevant types from `docs/TYPES.md` (API response and request types)
- `docs/CONVENTIONS.md` (frontend section)
- Existing shared components for reuse awareness

**Plugin dependency:** Requires `frontend-design` plugin to be installed. The agent prompt references it.

### Database Agent

**File:** `.claude/agents/database.md`

**Role:** Design and implement database schemas, migrations, seed data, and query optimization.

**Context to provide when delegating:**
- Entity definitions from `docs/TYPES.md`
- `docs/CONVENTIONS.md` (database section)
- Existing schema files in `apps/backend/src/db/schema/`
- Migration history

### Testing Agent

**File:** `.claude/agents/testing.md`

**Role:** Write tests that validate contracts between components. Catches when implementation doesn't match documented behavior.

**Context to provide when delegating:**
- The API contract or service contract being tested (from ARCHITECTURE.md and TYPES.md)
- The implementation being tested
- `docs/CONVENTIONS.md` (testing section)
- Existing test files in the same area

### Reviewer Agent

**File:** `.claude/agents/reviewer.md`

**Role:** Detect architectural drift, convention violations, and quality issues. The primary defense against the codebase diverging from the architecture.

**Context to provide when delegating:**
- `docs/ARCHITECTURE.md`
- `docs/CONVENTIONS.md`
- `docs/TYPES.md`
- The code produced during the phase being reviewed

### Documentation Agent

**File:** `.claude/agents/documentation.md`

**Role:** Produce and maintain repository documentation and knowledge base documentation. Also serves as a drift detection layer by comparing architecture docs against actual code.

**Context to provide when delegating:**
- `docs/ARCHITECTURE.md` (for design intent)
- The actual codebase (for implementation reality)
- Existing documentation (README, setup guides)

---

## Coordination Patterns

### When to Delegate vs. Work Directly

**Delegate when:**
- The task requires focused context on a specific domain (a particular service, the frontend, the database schema).
- The task is substantial enough that context isolation improves quality.
- Multiple independent tasks can run in parallel.

**Work directly when:**
- The task is small (editing a config file, updating a doc section, running a command).
- The task requires context from multiple agents' work areas simultaneously.
- The task is primarily coordination (updating PLAN.md, committing and tagging a milestone).

### Milestone Checkpoints

At each phase milestone:
1. Orchestrator runs existing tests.
2. Orchestrator invokes Reviewer agent on the phase's work.
3. Reviewer issues are fixed.
4. Orchestrator invokes Testing agent if test coverage is incomplete.
5. Tests pass.
6. Orchestrator invokes Documentation agent (at major milestones — Phases 1, 4, 7, 8).
7. Orchestrator commits, tags the milestone, and updates PLAN.md progress.

### Context Window Management

Each agent invocation should receive only the files relevant to its task. The Orchestrator is responsible for selecting the right context.

General sizing:
- **Backend Service Agent**: architecture section + types + conventions + 2-5 source files
- **Frontend Agent**: API contract + types + conventions + 5-10 component files
- **Database Agent**: types + conventions + schema files
- **Testing Agent**: contract + implementation + existing tests
- **Reviewer Agent**: architecture + conventions + types + relevant source files (may need to scope to specific service areas for large reviews)
- **Documentation Agent**: architecture + representative code samples + existing docs

### Session Management

- **Compaction threshold:** ~75-80% of context window. Commit current progress before compaction.
- **Between phases:** Start a fresh Claude Code session. Use the Orchestrator prompt with the current phase number. Review git history to pick up where you left off.
- **Recovery after compaction:** Re-read `docs/ARCHITECTURE.md` and `docs/PLAN.md`, review `git log --oneline -20`, run tests.
