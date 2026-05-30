import { useNavigate } from 'react-router-dom';
import type { SearchArtistHit } from '@alexandria/shared';

// A deterministic palette per artist name for the gradient avatar
const GRADIENTS: [string, string][] = [
  ['#f59e0b', '#d97706'],
  ['#0d9488', '#0f766e'],
  ['#6366f1', '#4f46e5'],
  ['#ec4899', '#db2777'],
  ['#10b981', '#059669'],
  ['#3b82f6', '#2563eb'],
];

function getGradient(name: string): [string, string] {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  return GRADIENTS[Math.abs(hash) % GRADIENTS.length];
}

function initials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

interface ArtistResultCardProps {
  artist: SearchArtistHit;
}

export function ArtistResultCard({ artist }: ArtistResultCardProps) {
  const navigate = useNavigate();
  const [from, to] = getGradient(artist.name);

  function handleClick() {
    navigate(`/?meta_artist=${encodeURIComponent(artist.name)}`);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: 12,
        borderRadius: 10,
        background: 'var(--ax-bg-elev)',
        border: '1px solid var(--ax-border)',
        cursor: 'pointer',
      }}
    >
      <div
        style={{
          width: 38,
          height: 38,
          borderRadius: '50%',
          background: `linear-gradient(135deg, ${from}, ${to})`,
          color: 'white',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 13,
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        {initials(artist.name)}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{artist.name}</div>
        <div className="ax-mono" style={{ fontSize: 11, color: 'var(--ax-fg-muted)' }}>
          {artist.modelCount} {artist.modelCount === 1 ? 'model' : 'models'}
        </div>
      </div>
    </div>
  );
}
