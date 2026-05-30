import { useNavigate } from 'react-router-dom';
import { Folder, ArrowRight } from 'lucide-react';
import type { SearchCollectionHit } from '@alexandria/shared';

interface CollectionResultRowProps {
  collection: SearchCollectionHit;
}

export function CollectionResultRow({ collection }: CollectionResultRowProps) {
  const navigate = useNavigate();

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/collections/${collection.id}`)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          navigate(`/collections/${collection.id}`);
        }
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        background: 'var(--ax-bg-elev)',
        border: '1px solid var(--ax-border)',
        borderRadius: 10,
        cursor: 'pointer',
      }}
    >
      <span
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          background: 'var(--ax-amber-tint)',
          color: 'var(--ax-amber-tint-fg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Folder size={14} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>{collection.name}</div>
        <div className="ax-mono" style={{ fontSize: 11.5, color: 'var(--ax-fg-muted)' }}>
          {collection.modelCount} {collection.modelCount === 1 ? 'model' : 'models'}
        </div>
      </div>
      <ArrowRight size={14} style={{ color: 'var(--ax-fg-muted)', flexShrink: 0 }} />
    </div>
  );
}
