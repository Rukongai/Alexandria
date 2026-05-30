import { useNavigate } from 'react-router-dom';
import { Hash } from 'lucide-react';
import type { SearchTagHit } from '@alexandria/shared';

interface TagResultPillProps {
  tag: SearchTagHit;
}

export function TagResultPill({ tag }: TagResultPillProps) {
  const navigate = useNavigate();

  function handleClick() {
    navigate(`/?tags=${encodeURIComponent(tag.name)}`);
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 14px',
        borderRadius: 999,
        background: 'var(--ax-amber-tint)',
        color: 'var(--ax-amber-tint-fg)',
        border: 'none',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: 13,
        fontWeight: 500,
      }}
    >
      <Hash size={11} />
      {tag.name}
      <span className="ax-mono" style={{ marginLeft: 4, fontSize: 11, opacity: 0.7 }}>
        {tag.modelCount}
      </span>
    </button>
  );
}
