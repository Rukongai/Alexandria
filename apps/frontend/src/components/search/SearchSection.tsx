import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

interface SearchSectionProps {
  title: string;
  count: number;
  icon: React.ReactNode;
  note?: string;
  children: React.ReactNode;
}

export function SearchSection({ title, count, icon, note, children }: SearchSectionProps) {
  const [open, setOpen] = useState(true);

  return (
    <section style={{ marginTop: 20 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 w-full text-left"
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '4px 0',
          marginBottom: open ? 10 : 0,
          color: 'inherit',
          fontFamily: 'inherit',
        }}
      >
        {icon}
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{title}</h2>
        <span
          className="ax-mono"
          style={{ fontSize: 12, color: 'var(--ax-fg-muted)' }}
        >
          {count}
        </span>
        {note && (
          <span style={{ marginLeft: 8, fontSize: 11.5, color: 'var(--ax-fg-subtle)', fontStyle: 'italic' }}>
            {note}
          </span>
        )}
        <span style={{ marginLeft: 'auto', color: 'var(--ax-fg-muted)' }}>
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>
      {open && children}
    </section>
  );
}
