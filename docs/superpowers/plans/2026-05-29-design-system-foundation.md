# Design System Foundation (P0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `design_handoff_alexandria` design language fully operational in the existing frontend — tokens, palettes, density, dark mode, fonts, icons — so every later redesign slice just composes it. No screen is redesigned in P0.

**Architecture:** Port `tokens.css` and run a deterministic transform that stores every color as HSL *channels* (`--ax-amber-h: 231 64% 50%`) plus a full-color alias (`--ax-amber: hsl(var(--ax-amber-h))`). A bridge file points shadcn's existing semantic vars (`--primary`, `--background`, …) at the channel vars, so Tailwind's `hsl(var(--x) / <alpha-value>)` opacity modifiers keep working and **every existing shadcn component inherits the new design with zero edits**. Palette / theme / density are React context providers that toggle root classes (`ax-palette-*`, `ax-dark`/`dark`, `ax-density-*`). A dev-only `/design-system` sandbox verifies fidelity.

**Tech Stack:** React 19, Vite 6, TypeScript, Tailwind 3.4 + shadcn-style primitives, Lucide, `@fontsource`, Vitest + Testing Library (jsdom).

**Branch:** `feat/design-system-foundation` (already created; spec committed here).

**Reference (read before starting):**
- Spec: `docs/superpowers/specs/2026-05-29-design-system-foundation-design.md`
- Source tokens: `design_handoff_alexandria/app/tokens.css`
- `apps/frontend/src/index.css`, `apps/frontend/tailwind.config.js`, `apps/frontend/src/hooks/use-theme.ts`, `apps/frontend/src/main.tsx`, `apps/frontend/index.html`

**Conventions:** All commands run from `apps/frontend/` unless noted. Tests: `npm test` (vitest run) or `npx vitest run <file>`. Commit messages follow `docs/CONVENTIONS.md` (conventional commits). Do **not** merge to main.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `apps/frontend/src/styles/ax-tokens.css` | The design system: palettes, density, dark, helpers — channel-var form | Create |
| `apps/frontend/scripts/transform-tokens.mjs` | One-shot, repeatable transform: hsl/hex color decls → channel pattern | Create |
| `apps/frontend/src/styles/ax-bridge.css` | Maps shadcn semantic vars → `--ax-*-h` channel vars | Create |
| `apps/frontend/src/index.css` | Tailwind entry; imports nothing of the old `:root` color block (replaced by bridge) | Modify |
| `apps/frontend/src/main.tsx` | Import token/bridge CSS + fonts; mount Palette/Density providers | Modify |
| `apps/frontend/index.html` | FOUC pre-paint script: apply `dark`/`ax-dark`, palette, density, `ax-app` | Modify |
| `apps/frontend/src/hooks/use-theme.ts` | Also toggle `.ax-dark` alongside `.dark` | Modify |
| `apps/frontend/src/hooks/use-palette.tsx` | Palette state (5), persisted, toggles `ax-palette-*` | Create |
| `apps/frontend/src/hooks/use-density.tsx` | Density state (3), persisted, toggles `ax-density-*` | Create |
| `apps/frontend/src/components/icons/index.ts` | Design-intent icon names → Lucide (+ local SVGs for gaps) | Create |
| `apps/frontend/src/pages/DesignSystemPage.tsx` | Dev-only sandbox proving tokens/type/chips/switchers | Create |
| `apps/frontend/src/App.tsx` | Add DEV-gated `/design-system` route | Modify |
| `apps/frontend/package.json` | Add `@fontsource/*` deps | Modify |

---

## Task 1: Port tokens.css with channel-var transform

**Files:**
- Create: `apps/frontend/src/styles/ax-tokens.css`
- Create: `apps/frontend/scripts/transform-tokens.mjs`

- [ ] **Step 1: Copy the handoff tokens verbatim**

Run (from repo root):
```bash
mkdir -p apps/frontend/src/styles apps/frontend/scripts
cp design_handoff_alexandria/app/tokens.css apps/frontend/src/styles/ax-tokens.css
```

- [ ] **Step 2: Write the transform script**

Create `apps/frontend/scripts/transform-tokens.mjs`:
```js
// Rewrites every `--ax-*: hsl(H S% L%);` color declaration into a channel pair:
//   --ax-name-h: H S% L%;
//   --ax-name: hsl(var(--ax-name-h));
// and `--ax-*: #ffffff;` into the equivalent `0 0% 100%` channel pair.
// Non-color tokens (fonts, density, radius, aspect, shadows) are left untouched.
// Idempotent-ish: re-running on already-transformed output is a no-op because
// transformed lines no longer match `: hsl(NUMBERS)` / `: #ffffff`.
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node transform-tokens.mjs <path-to-css>');
  process.exit(1);
}

const HSL = /^(\s*)(--ax-[\w-]+):\s*hsl\(([^)]+)\);\s*$/;
const HEX_WHITE = /^(\s*)(--ax-[\w-]+):\s*#ffffff;\s*$/i;

const out = readFileSync(file, 'utf8')
  .split('\n')
  .map((line) => {
    let m = line.match(HSL);
    if (m) {
      const [, indent, name, channels] = m;
      return `${indent}${name}-h: ${channels};\n${indent}${name}: hsl(var(${name}-h));`;
    }
    m = line.match(HEX_WHITE);
    if (m) {
      const [, indent, name] = m;
      return `${indent}${name}-h: 0 0% 100%;\n${indent}${name}: hsl(var(${name}-h));`;
    }
    return line;
  })
  .join('\n');

writeFileSync(file, out);
console.log(`transformed ${file}`);
```

- [ ] **Step 3: Run the transform**

Run (from repo root):
```bash
node apps/frontend/scripts/transform-tokens.mjs apps/frontend/src/styles/ax-tokens.css
```
Expected output: `transformed apps/frontend/src/styles/ax-tokens.css`

- [ ] **Step 4: Verify the transform produced channel pairs**

Run (from repo root):
```bash
grep -n -- '--ax-amber-h: 231 64% 50%;' apps/frontend/src/styles/ax-tokens.css
grep -n -- '--ax-amber: hsl(var(--ax-amber-h));' apps/frontend/src/styles/ax-tokens.css
grep -n -- '--ax-bg-elev-h: 0 0% 100%;' apps/frontend/src/styles/ax-tokens.css
# Sanity: shadow/font/density lines must be UNCHANGED (no -h suffix leaked in):
grep -n -- '--ax-shadow-sm:' apps/frontend/src/styles/ax-tokens.css
grep -n -- '--ax-card-gap: 14px;' apps/frontend/src/styles/ax-tokens.css
grep -n -- '--ax-font-display:' apps/frontend/src/styles/ax-tokens.css
```
Expected: first three greps each return one match; the last three return their original (untransformed) lines. If `--ax-shadow-sm-h` appears anywhere, the regex over-matched — STOP and fix the script.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/styles/ax-tokens.css apps/frontend/scripts/transform-tokens.mjs
git commit -m "feat(frontend): port design tokens with channel-var transform"
```

---

## Task 2: Bridge shadcn vars to channel tokens + restructure index.css

**Files:**
- Create: `apps/frontend/src/styles/ax-bridge.css`
- Modify: `apps/frontend/src/index.css`
- Modify: `apps/frontend/src/main.tsx`

- [ ] **Step 1: Create the bridge file**

Create `apps/frontend/src/styles/ax-bridge.css`:
```css
/* Bridge: point shadcn's semantic HSL-triplet vars at the design-token channel
 * vars (--ax-*-h). Because these resolve to bare "H S% L%" triplets, Tailwind's
 * `hsl(var(--x) / <alpha-value>)` opacity modifiers keep working unchanged.
 * The --ax-*-h vars are re-declared per palette and under .ax-dark by
 * ax-tokens.css, so every shadcn component follows palette + theme automatically.
 *
 * tailwind.config.js stays as `hsl(var(--primary))` etc. — DO NOT change it. */
@layer base {
  :root {
    --background: var(--ax-bg-h);
    --foreground: var(--ax-fg-h);

    --card: var(--ax-bg-elev-h);
    --card-foreground: var(--ax-fg-h);

    --popover: var(--ax-bg-elev-h);
    --popover-foreground: var(--ax-fg-h);

    --primary: var(--ax-amber-h);
    --primary-foreground: var(--ax-amber-fg-h);

    --secondary: var(--ax-bg-sunk-h);
    --secondary-foreground: var(--ax-fg-muted-h);

    --muted: var(--ax-bg-sunk-h);
    --muted-foreground: var(--ax-fg-muted-h);

    --accent: var(--ax-amber-tint-h);
    --accent-foreground: var(--ax-amber-tint-fg-h);

    --destructive: var(--ax-danger-h);
    --destructive-foreground: 0 0% 100%;

    --border: var(--ax-border-h);
    --input: var(--ax-border-h);
    --ring: var(--ax-amber-h);

    --radius: 0.5rem; /* keep shadcn radius scale in P0; revisit per-component in P1 */

    --sidebar: var(--ax-rail-h);
    --sidebar-foreground: var(--ax-rail-fg-h);
    --sidebar-border: var(--ax-rail-border-h);
    --sidebar-accent: var(--ax-rail-hover-h);
    --sidebar-accent-foreground: var(--ax-rail-fg-h);
  }
}
```

- [ ] **Step 2: Replace the old color block in index.css**

Overwrite `apps/frontend/src/index.css` with:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;

/* Color/theme vars now come from ax-tokens.css (channels) via ax-bridge.css.
 * Both are imported in main.tsx so they load alongside this file. */

@layer base {
  * {
    @apply border-border;
  }
  body {
    @apply bg-background text-foreground;
    font-feature-settings: "rlig" 1, "calt" 1;
  }
}
```

- [ ] **Step 3: Import tokens, bridge, and (placeholder) fonts in main.tsx**

In `apps/frontend/src/main.tsx`, replace the line `import './index.css';` with the block below (fonts are added for real in Task 3; include them now so the import site is final):
```tsx
import './styles/ax-tokens.css';
import './styles/ax-bridge.css';
import './index.css';
```

- [ ] **Step 4: Verify dev build renders with no CSS errors**

Run (from `apps/frontend`):
```bash
npm run dev
```
Expected: Vite starts with no CSS/PostCSS errors. Open the app — existing screens render in the **Slate** palette (cool gray + indigo), not amber. Stop the dev server (Ctrl-C).

- [ ] **Step 5: Verify production build compiles**

Run (from `apps/frontend`):
```bash
npm run build
```
Expected: `tsc -b && vite build` completes with no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/styles/ax-bridge.css apps/frontend/src/index.css apps/frontend/src/main.tsx
git commit -m "feat(frontend): bridge shadcn theme vars to design tokens"
```

---

## Task 3: Self-host fonts via @fontsource

**Files:**
- Modify: `apps/frontend/package.json`
- Modify: `apps/frontend/src/main.tsx`

- [ ] **Step 1: Install font packages**

Run (from `apps/frontend`):
```bash
npm install @fontsource/inter-tight @fontsource/inter @fontsource/jetbrains-mono
```
Expected: three packages added to `dependencies` in `apps/frontend/package.json`.

- [ ] **Step 2: Import the font CSS in main.tsx**

In `apps/frontend/src/main.tsx`, add these imports at the very top of the file (above the React import), so the `--ax-font-*` stacks resolve to real loaded faces:
```tsx
import '@fontsource/inter-tight/400.css';
import '@fontsource/inter-tight/600.css';
import '@fontsource/inter-tight/700.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
```

- [ ] **Step 3: Verify build still compiles**

Run (from `apps/frontend`):
```bash
npm run build
```
Expected: build completes; no "cannot resolve @fontsource/..." errors.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/package.json apps/frontend/package-lock.json apps/frontend/src/main.tsx ../../package-lock.json
git commit -m "feat(frontend): self-host Inter Tight, Inter, JetBrains Mono fonts"
```
> Note: if the monorepo uses a single root lock file, `apps/frontend/package-lock.json` may not exist — `git add -A apps/frontend && git add package-lock.json` from repo root covers both cases. Drop paths that don't exist.

---

## Task 4: use-theme also toggles .ax-dark

**Files:**
- Modify: `apps/frontend/src/hooks/use-theme.ts`
- Test: `apps/frontend/src/hooks/use-theme.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/hooks/use-theme.test.tsx`:
```tsx
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ThemeProvider, useTheme } from './use-theme';

function wrapper({ children }: { children: React.ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
  });
  afterEach(() => {
    document.documentElement.className = '';
  });

  it('applies both .dark and .ax-dark when theme is dark', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => result.current.setTheme('dark'));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('ax-dark')).toBe(true);
  });

  it('removes both .dark and .ax-dark when theme is light', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => result.current.setTheme('dark'));
    act(() => result.current.setTheme('light'));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.classList.contains('ax-dark')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `apps/frontend`):
```bash
npx vitest run src/hooks/use-theme.test.tsx
```
Expected: the first test FAILS — `ax-dark` is not added yet.

- [ ] **Step 3: Update applyTheme to toggle .ax-dark**

In `apps/frontend/src/hooks/use-theme.ts`, replace the `applyTheme` function body's class logic so both classes toggle together:
```ts
function applyTheme(theme: Theme): 'light' | 'dark' {
  const resolved = theme === 'system' ? getSystemTheme() : theme;
  const root = document.documentElement;
  if (resolved === 'dark') {
    root.classList.add('dark', 'ax-dark');
  } else {
    root.classList.remove('dark', 'ax-dark');
  }
  return resolved;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `apps/frontend`):
```bash
npx vitest run src/hooks/use-theme.test.tsx
```
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/hooks/use-theme.ts apps/frontend/src/hooks/use-theme.test.tsx
git commit -m "feat(frontend): sync .ax-dark with .dark in theme provider"
```

---

## Task 5: Palette provider

**Files:**
- Create: `apps/frontend/src/hooks/use-palette.tsx`
- Test: `apps/frontend/src/hooks/use-palette.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/hooks/use-palette.test.tsx`:
```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { PaletteProvider, usePalette, PALETTES } from './use-palette';

function wrapper({ children }: { children: React.ReactNode }) {
  return <PaletteProvider>{children}</PaletteProvider>;
}

describe('usePalette', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
  });

  it('defaults to slate and applies ax-palette-slate', () => {
    const { result } = renderHook(() => usePalette(), { wrapper });
    expect(result.current.palette).toBe('slate');
    expect(document.documentElement.classList.contains('ax-palette-slate')).toBe(true);
  });

  it('switches palette, swapping the root class and persisting', () => {
    const { result } = renderHook(() => usePalette(), { wrapper });
    act(() => result.current.setPalette('plum'));
    expect(document.documentElement.classList.contains('ax-palette-plum')).toBe(true);
    expect(document.documentElement.classList.contains('ax-palette-slate')).toBe(false);
    expect(localStorage.getItem('ax-palette')).toBe('plum');
  });

  it('exposes all five palettes', () => {
    expect(PALETTES).toEqual(['slate', 'workshop', 'sage', 'plum', 'graphite']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `apps/frontend`):
```bash
npx vitest run src/hooks/use-palette.test.tsx
```
Expected: FAIL — module `./use-palette` does not exist.

- [ ] **Step 3: Implement the palette provider**

Create `apps/frontend/src/hooks/use-palette.tsx`:
```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export const PALETTES = ['slate', 'workshop', 'sage', 'plum', 'graphite'] as const;
export type Palette = (typeof PALETTES)[number];

const STORAGE_KEY = 'ax-palette';
const DEFAULT_PALETTE: Palette = 'slate';

interface PaletteContextValue {
  palette: Palette;
  setPalette: (p: Palette) => void;
}

const PaletteContext = createContext<PaletteContextValue | null>(null);

function isPalette(v: unknown): v is Palette {
  return typeof v === 'string' && (PALETTES as readonly string[]).includes(v);
}

function applyPalette(palette: Palette) {
  const root = document.documentElement;
  for (const p of PALETTES) root.classList.remove(`ax-palette-${p}`);
  root.classList.add(`ax-palette-${palette}`);
}

export function PaletteProvider({ children }: { children: ReactNode }) {
  const [palette, setPaletteState] = useState<Palette>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (isPalette(stored)) return stored;
    } catch {
      // localStorage unavailable
    }
    return DEFAULT_PALETTE;
  });

  useEffect(() => {
    applyPalette(palette);
  }, [palette]);

  function setPalette(p: Palette) {
    try {
      localStorage.setItem(STORAGE_KEY, p);
    } catch {
      // ignore
    }
    setPaletteState(p);
  }

  return (
    <PaletteContext.Provider value={{ palette, setPalette }}>{children}</PaletteContext.Provider>
  );
}

export function usePalette(): PaletteContextValue {
  const ctx = useContext(PaletteContext);
  if (!ctx) throw new Error('usePalette must be used within a PaletteProvider');
  return ctx;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `apps/frontend`):
```bash
npx vitest run src/hooks/use-palette.test.tsx
```
Expected: all three tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/hooks/use-palette.tsx apps/frontend/src/hooks/use-palette.test.tsx
git commit -m "feat(frontend): add palette provider (5 palettes, persisted)"
```

---

## Task 6: Density provider

**Files:**
- Create: `apps/frontend/src/hooks/use-density.tsx`
- Test: `apps/frontend/src/hooks/use-density.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/hooks/use-density.test.tsx`:
```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { DensityProvider, useDensity, DENSITIES } from './use-density';

function wrapper({ children }: { children: React.ReactNode }) {
  return <DensityProvider>{children}</DensityProvider>;
}

describe('useDensity', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
  });

  it('defaults to cozy with NO density class (cozy is the token base)', () => {
    const { result } = renderHook(() => useDensity(), { wrapper });
    expect(result.current.density).toBe('cozy');
    expect(document.documentElement.classList.contains('ax-density-cozy')).toBe(false);
    expect(document.documentElement.classList.contains('ax-density-compact')).toBe(false);
    expect(document.documentElement.classList.contains('ax-density-comfy')).toBe(false);
  });

  it('applies ax-density-compact when set to compact and persists', () => {
    const { result } = renderHook(() => useDensity(), { wrapper });
    act(() => result.current.setDensity('compact'));
    expect(document.documentElement.classList.contains('ax-density-compact')).toBe(true);
    expect(localStorage.getItem('ax-density')).toBe('compact');
  });

  it('switching back to cozy removes the density class', () => {
    const { result } = renderHook(() => useDensity(), { wrapper });
    act(() => result.current.setDensity('comfy'));
    act(() => result.current.setDensity('cozy'));
    expect(document.documentElement.classList.contains('ax-density-comfy')).toBe(false);
    expect(document.documentElement.classList.contains('ax-density-cozy')).toBe(false);
  });

  it('exposes all three densities', () => {
    expect(DENSITIES).toEqual(['compact', 'cozy', 'comfy']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `apps/frontend`):
```bash
npx vitest run src/hooks/use-density.test.tsx
```
Expected: FAIL — module `./use-density` does not exist.

- [ ] **Step 3: Implement the density provider**

Create `apps/frontend/src/hooks/use-density.tsx`:
```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export const DENSITIES = ['compact', 'cozy', 'comfy'] as const;
export type Density = (typeof DENSITIES)[number];

const STORAGE_KEY = 'ax-density';
const DEFAULT_DENSITY: Density = 'cozy';

interface DensityContextValue {
  density: Density;
  setDensity: (d: Density) => void;
}

const DensityContext = createContext<DensityContextValue | null>(null);

function isDensity(v: unknown): v is Density {
  return typeof v === 'string' && (DENSITIES as readonly string[]).includes(v);
}

function applyDensity(density: Density) {
  const root = document.documentElement;
  for (const d of DENSITIES) root.classList.remove(`ax-density-${d}`);
  // 'cozy' is the token base (no modifier class needed).
  if (density !== 'cozy') root.classList.add(`ax-density-${density}`);
}

export function DensityProvider({ children }: { children: ReactNode }) {
  const [density, setDensityState] = useState<Density>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (isDensity(stored)) return stored;
    } catch {
      // localStorage unavailable
    }
    return DEFAULT_DENSITY;
  });

  useEffect(() => {
    applyDensity(density);
  }, [density]);

  function setDensity(d: Density) {
    try {
      localStorage.setItem(STORAGE_KEY, d);
    } catch {
      // ignore
    }
    setDensityState(d);
  }

  return (
    <DensityContext.Provider value={{ density, setDensity }}>{children}</DensityContext.Provider>
  );
}

export function useDensity(): DensityContextValue {
  const ctx = useContext(DensityContext);
  if (!ctx) throw new Error('useDensity must be used within a DensityProvider');
  return ctx;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `apps/frontend`):
```bash
npx vitest run src/hooks/use-density.test.tsx
```
Expected: all four tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/hooks/use-density.tsx apps/frontend/src/hooks/use-density.test.tsx
git commit -m "feat(frontend): add density provider (compact/cozy/comfy, persisted)"
```

---

## Task 7: Mount providers + FOUC script + ax-app class

**Files:**
- Modify: `apps/frontend/src/main.tsx`
- Modify: `apps/frontend/index.html`

- [ ] **Step 1: Mount the providers in main.tsx**

In `apps/frontend/src/main.tsx`, add imports near the other hook imports:
```tsx
import { PaletteProvider } from './hooks/use-palette';
import { DensityProvider } from './hooks/use-density';
```
Then wrap the tree so Palette and Density sit just inside ThemeProvider. The provider block becomes:
```tsx
<ThemeProvider>
  <PaletteProvider>
    <DensityProvider>
      <DisplayPreferencesProvider>
        <AuthProvider>
          <App />
          <Toaster />
        </AuthProvider>
      </DisplayPreferencesProvider>
    </DensityProvider>
  </PaletteProvider>
</ThemeProvider>
```

- [ ] **Step 2: Update the FOUC pre-paint script + add ax-app to body**

Overwrite `apps/frontend/index.html` with:
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Alexandria</title>
    <script>
      (function () {
        var root = document.documentElement;
        // Theme
        var t = localStorage.getItem('theme');
        var dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
        if (dark) root.classList.add('dark', 'ax-dark');
        // Palette (default slate)
        var palettes = ['slate', 'workshop', 'sage', 'plum', 'graphite'];
        var p = localStorage.getItem('ax-palette');
        root.classList.add('ax-palette-' + (palettes.indexOf(p) >= 0 ? p : 'slate'));
        // Density (cozy = base, no class)
        var d = localStorage.getItem('ax-density');
        if (d === 'compact' || d === 'comfy') root.classList.add('ax-density-' + d);
      })();
    </script>
  </head>
  <body class="ax-app">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Verify the full test suite passes**

Run (from `apps/frontend`):
```bash
npm test
```
Expected: all tests pass (existing + the new theme/palette/density tests).

- [ ] **Step 4: Manually verify switching works live**

Run (from `apps/frontend`): `npm run dev`. In the browser console, run each and confirm the app restyles instantly:
```js
document.documentElement.className = 'ax-palette-workshop';     // cobalt
document.documentElement.className = 'ax-palette-graphite ax-dark'; // mono dark
document.documentElement.className = 'ax-palette-slate';        // back to default
```
Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/main.tsx apps/frontend/index.html
git commit -m "feat(frontend): mount palette/density providers and pre-paint root classes"
```

---

## Task 8: Icon mapping module

**Files:**
- Create: `apps/frontend/src/components/icons/index.ts`

- [ ] **Step 1: Create the icon map**

Create `apps/frontend/src/components/icons/index.ts`. Re-export the Lucide glyphs the design references under design-intent names. Local SVG components are only needed for glyphs with no Lucide equivalent — none are required for the sandbox, so this file is pure re-exports for now:
```ts
/**
 * Design-intent icon names → Lucide glyphs.
 * Screens import from here (not lucide-react directly) so a glyph can be
 * swapped or replaced with a local SVG in one place. Extend as screens land.
 */
export {
  Folder as CollectionsIcon,
  User as ArtistIcon,
  Tag as TagIcon,
  Sparkles as SmartIcon,
  LayoutGrid as GridViewIcon,
  List as ListViewIcon,
  Rows3 as GroupViewIcon,
  Upload as UploadIcon,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Boxes as LibraryIcon,
  ChevronRight as ChevronRightIcon,
  Plus as AddIcon,
  X as CloseIcon,
} from 'lucide-react';
```

- [ ] **Step 2: Verify it type-checks**

Run (from `apps/frontend`):
```bash
npx tsc --noEmit
```
Expected: no errors. (If any named export above is missing from the installed Lucide version, swap it for the nearest available glyph and note it.)

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/components/icons/index.ts
git commit -m "feat(frontend): add design-intent icon mapping module"
```

---

## Task 9: Design-system sandbox route (DEV-only)

**Files:**
- Create: `apps/frontend/src/pages/DesignSystemPage.tsx`
- Modify: `apps/frontend/src/App.tsx`

- [ ] **Step 1: Build the sandbox page**

Create `apps/frontend/src/pages/DesignSystemPage.tsx`:
```tsx
import { PALETTES, usePalette } from '../hooks/use-palette';
import { DENSITIES, useDensity } from '../hooks/use-density';
import { useTheme } from '../hooks/use-theme';

const SURFACES = [
  '--ax-bg', '--ax-bg-elev', '--ax-bg-sunk', '--ax-fg', '--ax-fg-muted',
  '--ax-fg-subtle', '--ax-border', '--ax-border-strong',
];
const BRAND = [
  '--ax-amber', '--ax-amber-tint', '--ax-teal', '--ax-teal-tint',
  '--ax-success', '--ax-warning', '--ax-danger',
];

function Swatch({ token }: { token: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 120 }}>
      <div
        style={{
          height: 48,
          borderRadius: 8,
          background: `var(${token})`,
          border: '1px solid var(--ax-border)',
        }}
      />
      <code className="ax-code" style={{ fontSize: 11 }}>{token}</code>
    </div>
  );
}

export function DesignSystemPage() {
  const { palette, setPalette } = usePalette();
  const { density, setDensity } = useDensity();
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <div className="ax-app" style={{ padding: 32, minHeight: '100vh', background: 'var(--ax-bg)' }}>
      <h1 style={{ marginBottom: 8 }}>Alexandria Design System</h1>
      <p style={{ color: 'var(--ax-fg-muted)', marginBottom: 24 }}>
        Verification sandbox — tokens, type, helpers, switchers. DEV-only.
      </p>

      {/* Switchers */}
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 32 }}>
        <label>
          Palette{' '}
          <select value={palette} onChange={(e) => setPalette(e.target.value as never)}>
            {PALETTES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label>
          Density{' '}
          <select value={density} onChange={(e) => setDensity(e.target.value as never)}>
            {DENSITIES.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <label>
          Theme{' '}
          <select value={resolvedTheme} onChange={(e) => setTheme(e.target.value as never)}>
            <option value="light">light</option>
            <option value="dark">dark</option>
            <option value="system">system</option>
          </select>
        </label>
      </div>

      <h2>Surfaces</h2>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: '12px 0 28px' }}>
        {SURFACES.map((t) => <Swatch key={t} token={t} />)}
      </div>

      <h2>Brand &amp; status</h2>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: '12px 0 28px' }}>
        {BRAND.map((t) => <Swatch key={t} token={t} />)}
      </div>

      <h2>Typography</h2>
      <div style={{ margin: '12px 0 28px' }}>
        <p className="ax-display" style={{ fontSize: 32 }}>Display — Degular / Inter Tight</p>
        <p style={{ fontSize: 16 }}>UI / body — Neue Haas / Inter. Tabular nums: 1234567890</p>
        <p className="ax-code">Mono — JetBrains Mono · /lib/123/models/abc</p>
      </div>

      <h2>Chips &amp; helpers</h2>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0 28px' }}>
        <span className="ax-chip">Neutral</span>
        <span className="ax-chip ax-chip-amber">Primary</span>
        <span className="ax-chip ax-chip-teal">Accent</span>
        <span className="ax-chip ax-chip-strong">Strong</span>
        <span className="ax-pulse" style={{ width: 8, height: 8, background: 'var(--ax-teal)' }} />
        <span style={{ color: 'var(--ax-fg-subtle)' }}>← pulse</span>
      </div>

      <h2>shadcn bridge check</h2>
      <p style={{ color: 'var(--ax-fg-muted)', marginBottom: 8 }}>
        These use Tailwind utilities + opacity modifiers; they must follow the palette above.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 text-sm">
          Primary button
        </button>
        <div className="bg-muted/30 border border-border rounded-md px-3 py-1.5 text-sm text-muted-foreground">
          muted/30 + border
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the DEV-gated route**

In `apps/frontend/src/App.tsx`, add the import:
```tsx
import { DesignSystemPage } from './pages/DesignSystemPage';
```
Then add this route inside `<Routes>`, immediately before the catch-all `<Route path="*" ... />` line:
```tsx
{import.meta.env.DEV && (
  <Route path="/design-system" element={<DesignSystemPage />} />
)}
```

- [ ] **Step 3: Verify the sandbox renders and switchers work**

Run (from `apps/frontend`): `npm run dev`, open `/design-system`. Confirm:
- All swatches render with sensible colors (no black/transparent boxes).
- Switching **Palette** restyles both the swatches AND the "shadcn bridge check" button (proves the channel bridge follows palettes).
- Switching **Theme** to dark flips surfaces; switching **Density** is a no-op visually here (no density-driven elements) but must not error.
- Reload the page — selections persist (no flash of the wrong palette/theme).

Stop the dev server.

- [ ] **Step 4: Verify build excludes nothing it shouldn't / still compiles**

Run (from `apps/frontend`):
```bash
npm run build
```
Expected: compiles. (The route is DEV-gated at runtime via `import.meta.env.DEV`; it's fine for the component to exist in the bundle.)

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/pages/DesignSystemPage.tsx apps/frontend/src/App.tsx
git commit -m "feat(frontend): add DEV-only design-system verification sandbox"
```

---

## Task 10: Acceptance pass + regression sweep

**Files:** none (verification only)

- [ ] **Step 1: Full test + typecheck + build**

Run (from `apps/frontend`):
```bash
npm test && npx tsc --noEmit && npm run build
```
Expected: all green.

- [ ] **Step 2: Visual regression sweep of existing screens**

Run `npm run dev`, log in, and walk each existing screen in **Slate light** then **Slate dark** (toggle theme from the header): Library grid, a Model detail, Collections, Upload, Settings, Login. Confirm:
- No invisible text (foreground vs background contrast intact).
- Opacity-modifier surfaces render as subtle tints, **not** full-opacity blocks (e.g. `bg-muted/30` table headers, `hover:bg-primary/90` buttons). This is the key channel-bridge regression check.
- No leftover warm-amber elements clashing with the indigo Slate primary.

- [ ] **Step 3: Note any stragglers (do not fix in P0)**

If any component hardcodes a color (hex/`amber`/`stone` literal in className) instead of a token and looks wrong, record it in `docs/superpowers/specs/2026-05-29-design-system-foundation-design.md` under a new "## P0 follow-ups (handle in P1)" heading and commit that note. P0 does not redesign components; it only proves the foundation.

- [ ] **Step 4: Final commit (if notes were added)**

```bash
git add docs/superpowers/specs/2026-05-29-design-system-foundation-design.md
git commit -m "docs: record P0 design-system follow-ups for P1"
```

- [ ] **Step 5: Open the PR**

Run (from repo root):
```bash
git push -u origin feat/design-system-foundation
gh pr create --title "P0: Design System Foundation" --body "$(cat <<'EOF'
Implements P0 of the Alexandria redesign program.

- Ports design tokens (channel-var form) from the handoff bundle.
- Bridges shadcn theme vars to the channel tokens, preserving Tailwind opacity modifiers — existing components inherit the new Slate design with no edits.
- Adds palette (5), theme (.ax-dark synced), and density (3) providers, persisted + pre-painted to avoid FOUC.
- Self-hosts Inter Tight / Inter / JetBrains Mono.
- Adds a design-intent icon map and a DEV-only /design-system sandbox.

Spec: docs/superpowers/specs/2026-05-29-design-system-foundation-design.md
Plan: docs/superpowers/plans/2026-05-29-design-system-foundation.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review (completed)

**Spec coverage:** U1 tokens → Task 1; U2 bridge → Task 2 (+ tailwind.config left unchanged, verified); U3 palette/theme/density state → Tasks 4–7; U4 fonts → Task 3; U5 icons → Task 8; U6 sandbox → Task 9. Acceptance criteria §3.5 → Task 10. Risks (§3.4): opacity modifiers covered by the channel-var approach + Task 10 Step 2; dark-class duality → Task 4; default identity shift → Task 2 Step 4 / Task 10.

**Placeholder scan:** No TBD/TODO; every code/CSS file is given in full; every command has expected output.

**Type/name consistency:** `PALETTES`/`Palette`/`usePalette`/`PaletteProvider`, `DENSITIES`/`Density`/`useDensity`/`DensityProvider`, storage keys `ax-palette`/`ax-density`/`theme`, channel suffix `-h`, and the bridge var names match across tasks, the FOUC script, and the sandbox.

**Note for executor:** `renderHook`/`act` are imported from `@testing-library/react` (v16, installed). Tests run in jsdom (configured). The channel transform is the one irreversible-ish bulk edit — Task 1 Step 4's grep guard catches over-matching before commit.
