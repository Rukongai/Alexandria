# Alexandria Redesign — Program Roadmap & P0 (Design System Foundation) Spec

**Date:** 2026-05-29
**Status:** Approved (design), pending implementation plan
**Source design:** `design_handoff_alexandria/` (handoff bundle: 19 screens, `app/tokens.css`, JSX prototypes)

---

## 1. Context

The `design_handoff_alexandria/` bundle is a high-fidelity design handoff for Alexandria — a 3D
model library app. The centerpiece is the **Pivot Workspace**: Collections, Artists, Tags, and
Smart Collections are peer organizing axes; the user picks the primary axis in the left rail and
the whole UI reshapes around it.

The handoff is intentionally ahead of the current product. It assumes subsystems that do not yet
exist in the codebase: multi-library, smart (rule-based) collections, users/roles/admin, a 3D
viewer, and Artists promoted from a metadata field to a first-class pivot axis.

### Current codebase (verified)

- **Frontend:** React 19 + Vite + TypeScript, Tailwind 3.4 + shadcn-style primitives, React Query 5,
  React Router 7, Lucide icons. Existing screens: Library grid, Model detail, Collections,
  Upload, Settings, Login. Theme = warm-stone/amber, light/dark via `.dark` class.
- **Backend:** Fastify, service-oriented (Model/Metadata/Collection/Search/Auth/Ingestion/…),
  Postgres + Redis + BullMQ. Single-user, single-library. Tags + Artist are metadata fields
  (`MetadataService`); Collections are a separate entity. Envelope `{data, meta, errors}`,
  cursor pagination. See `docs/ARCHITECTURE.md`.

---

## 2. Program decomposition (approved)

This is a **program of work**, not one task. Each sub-project below gets its own
spec → plan → implementation cycle. Ordered for incremental value and minimal rework.

**Framing decision (approved):** Full phased program — implement everything eventually,
including the new backend subsystems.

**Library timing decision (approved):** Introduce a **thin Library data-model layer early**
(lands with P1): a `libraries` table with one auto-seeded default library, models/collections
FK'd to it, UI stays single-library (no switcher) until P5. This makes the data model correct
from the start so P5 is mostly UI + invites, not a high-risk query migration.

**Token strategy decision (approved):** **Bridge layer** — drop `tokens.css` in verbatim, point
shadcn's existing CSS vars at the `--ax-*` vars so all existing components inherit the new design
with no rewrite, while keeping runtime palette-switching + density.

| Phase | Title | Backend? | Summary |
|-------|-------|----------|---------|
| **P0** | Design System Foundation | no | Port tokens, bridge to shadcn, palette/theme/density state, fonts, icon strategy, verification sandbox. **(this spec)** |
| **P1** | App Shell + Pivot Workspace | thin Library layer | Dark rail + axis picker + main pane/header; Pivot by Collections / Tags / Artists end-to-end; view toggle (grid/list/group), density, thumbnails toggle. Smart axis deferred. |
| **P2** | Model Detail + 3D Viewer | no | Restyle detail with multi-hierarchy breadcrumb; 3D modal (files already served). |
| **P3** | Workflow Pages | no | Restyle Upload + global Search. |
| **P4** | Smart Collections | yes | New entity + rule engine (extends SearchService); Smart pivot axis + composer. |
| **P5** | Multi-library | yes | Surface the Library layer: All-Libraries home, switcher, `/lib/:id` routing, per-library scoping in UI. |
| **P6** | Users / Roles / Admin | yes | Multi-user + roles in AuthService; admin pages (libraries, users, bulk edit, auto-tagging). |
| **P7** | Empty states + polish | no | Empty library, empty collections, final pass. |

---

## 3. P0 — Design System Foundation (detailed spec)

### 3.1 Goal

Get the handoff's design language fully operational in the existing frontend so every later
slice composes it. **No screen redesign in P0** — this is foundation + a verification sandbox.
Success = the existing app renders in the new Slate design with palette/theme/density switching
working, and a sandbox route proves tokens, type, chips, and helpers are pixel-faithful.

### 3.2 Units of work

#### U1 — Port `tokens.css` verbatim

- New file `apps/frontend/src/styles/ax-tokens.css` containing `design_handoff_alexandria/app/tokens.css`
  **verbatim** (per handoff instruction "take this verbatim").
- Imported from `index.css` (after the `@tailwind` directives, before the bridge `@layer`).
- Includes: 5 palettes (`.ax-palette-{slate,workshop,sage,plum,graphite}`), `.ax-dark`
  overrides per palette, density modifiers (`.ax-density-{compact,comfy}`; cozy = base),
  `.ax-app` container, helper classes (`.ax-chip`(+`-amber/-teal/-strong`), `.ax-divider`,
  `.ax-mono`, `.ax-code`, `.ax-pulse`, `.ax-scroll`), the `@keyframes ax-pulse`.

#### U2 — Bridge `--ax-*` → shadcn vars (the key nuance)

shadcn vars are **bare HSL triplets** (`35 92% 48%`) consumed as `hsl(var(--primary))`.
`--ax-*` vars are **full color values** (`hsl(231 64% 50%)`). The bridge therefore has two parts:

1. **Rewire shadcn semantic vars** to ax equivalents in a bridge `@layer base` block (these
   override the values currently in `index.css`):

   | shadcn var | ← maps to |
   |---|---|
   | `--background` | `--ax-bg` |
   | `--foreground` | `--ax-fg` |
   | `--card` / `--popover` | `--ax-bg-elev` |
   | `--card-foreground` / `--popover-foreground` | `--ax-fg` |
   | `--primary` | `--ax-amber` |
   | `--primary-foreground` | `--ax-amber-fg` |
   | `--secondary` | `--ax-bg-sunk` |
   | `--secondary-foreground` | `--ax-fg-muted` |
   | `--muted` | `--ax-bg-sunk` |
   | `--muted-foreground` | `--ax-fg-muted` |
   | `--accent` | `--ax-amber-tint` |
   | `--accent-foreground` | `--ax-amber-tint-fg` |
   | `--destructive` | `--ax-danger` |
   | `--destructive-foreground` | `#fff` |
   | `--border` / `--input` | `--ax-border` |
   | `--ring` | `--ax-amber` |
   | `--sidebar` | `--ax-rail` |
   | `--sidebar-foreground` | `--ax-rail-fg` |
   | `--sidebar-border` | `--ax-rail-border` |
   | `--sidebar-accent` | `--ax-rail-hover` |
   | `--sidebar-accent-foreground` | `--ax-rail-fg` |

2. **Unwrap in `tailwind.config.js`:** change color definitions from `hsl(var(--x))` to
   `var(--x)` so utilities consume the full color values now stored in those vars. `--radius`
   stays as-is (map to `--ax-card-radius` conceptually but keep shadcn's rem-based radius scale).

   > Implementation note for the plan: verify no remaining `hsl(var(...))` usages assume a bare
   > triplet. The `--ax-card-radius` is `12px`; shadcn radius is `0.5rem`. Keep shadcn's radius
   > tokens unchanged in P0 to avoid breaking existing components; revisit per-component in P1.

**Outcome:** existing shadcn components (`button`, `card`, `badge`, `dialog`, …) render in the
new design with **no component edits**.

#### U3 — Root state: palette / theme / density

- Extend the existing `use-theme` (light/dark/system) to also apply `.ax-dark` whenever `.dark`
  is applied, keeping shadcn and ax dark in sync from a single source of truth.
- New `use-palette` hook/provider: `slate|workshop|sage|plum|graphite`, default **slate**,
  persisted to localStorage, applies `ax-palette-*` class on `<html>`.
- New `use-density` hook/provider: `compact|cozy|comfy`, default **cozy**, persisted, applies
  `ax-density-*` (cozy applies no modifier class — it's the base).
- Wire all providers in `main.tsx`. Apply the `ax-app` class to the app root container so the
  font + tabular-numerics + box-sizing rules take effect.
- These three are **per-device user preferences** (localStorage now; server-persisted user
  prefs are a later phase). The Settings page will expose them in a later slice; P0 only needs
  them switchable via the sandbox.

#### U4 — Fonts (self-hosted)

- Add `@fontsource` packages: Inter Tight (display fallback), Inter (UI fallback),
  JetBrains Mono (mono). Import in `main.tsx`.
- The `--ax-font-*` stacks already name these as fallbacks; no token edits needed. Licensed
  Degular / Neue Haas faces can be dropped in later via `@font-face`/Adobe kit with no code
  change.

#### U5 — Icon strategy

- Keep **Lucide** as the icon library. Establish a single mapping module
  `components/icons/index.ts` that re-exports the Lucide glyphs the design uses under
  design-intent names, and houses any local SVG components for glyphs with no Lucide match.
- P0 only needs the *pattern* established + the handful of icons the sandbox uses. Per-screen
  icons are ported incrementally in P1+.

#### U6 — Verification sandbox

- Dev-only route `/design-system` rendering: color swatches (all semantic vars), the type scale
  (display/ui/mono), chip variants, `.ax-pulse`, density samples, and live palette/theme/density
  switchers.
- Purpose: confirm the foundation is faithful before touching real screens.
- Gate behind `import.meta.env.DEV` (or remove before P0 merges) so it doesn't ship to prod.

### 3.3 Explicitly out of scope for P0

- React shell primitives (rail, header, axis picker) → **P1**.
- Thin Library backend layer → lands with **P1**.
- Redesigning any real screen → P1+.
- Server-side persistence of user prefs → later phase.
- Full per-icon port → incremental.

### 3.4 Risks / watch-items

- **Unwrapping Tailwind colors** could break any utility/component that assumes a bare HSL
  triplet (e.g. custom `hsl(var(--border) / 0.5)` alpha usages). The plan must grep for
  `var(--` inside `hsl(`/`/ <alpha>` patterns and convert or provide alpha-compatible vars.
  Tailwind opacity modifiers (e.g. `bg-primary/50`) rely on the `<alpha-value>` placeholder;
  switching to raw `var()` colors disables those. Audit usages; where opacity modifiers are
  needed, keep a triplet var or use explicit rgba/color-mix.
- **Default identity shift** (amber → Slate/indigo) is intended but visible across the whole app.
- **Dark-class duality** (`.dark` + `.ax-dark`): ensure both are always applied/removed together.

### 3.5 Acceptance criteria

1. `tokens.css` present verbatim and imported; no console errors.
2. Existing screens (Library, Detail, Collections, Upload, Settings, Login) render in Slate
   light + dark with no broken colors, no hardcoded-amber leftovers visibly clashing.
3. Palette switch (all 5), theme switch (light/dark/system), density switch (3) all work live
   from the sandbox and persist across reload.
4. `/design-system` sandbox renders swatches/type/chips/helpers faithfully and is DEV-gated.
5. Tailwind opacity-modifier audit complete; no regressions in existing components.
6. No backend changes. Tests pass.
