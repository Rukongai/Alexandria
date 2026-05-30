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
