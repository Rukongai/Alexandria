import { ChevronDown, Plus, X } from 'lucide-react';
import type { MetadataFieldDetail } from '@alexandria/shared';
import { cn } from '../../lib/utils';

type SegmentKind = 'collection' | `metadata.${string}` | 'model';

interface Segment {
  id: string;
  kind: SegmentKind;
}

interface PatternBuilderProps {
  segments: Segment[];
  metadataFields: MetadataFieldDetail[];
  onChange: (segments: Segment[]) => void;
}

let segmentCounter = 0;
function newId() {
  return String(++segmentCounter);
}

export function createDefaultSegments(): Segment[] {
  return [{ id: newId(), kind: 'model' }];
}

export function segmentsToPattern(segments: Segment[]): string {
  return segments
    .map((s) => {
      if (s.kind === 'model') return '{model}';
      if (s.kind === 'collection') return '{Collection}';
      // metadata.<slug>
      const slug = s.kind.replace('metadata.', '');
      return `{metadata.${slug}}`;
    })
    .join('/');
}

function SegmentSelect({
  value,
  metadataFields,
  onChange,
}: {
  value: SegmentKind;
  metadataFields: MetadataFieldDetail[];
  onChange: (kind: SegmentKind) => void;
}) {
  return (
    <div className="relative inline-flex items-center">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as SegmentKind)}
        className={cn(
          'appearance-none rounded-md border border-border bg-background pr-7 pl-3 py-1.5 text-sm',
          'focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer',
          value === 'model' && 'text-muted-foreground cursor-default pointer-events-none'
        )}
        disabled={value === 'model'}
      >
        <option value="collection">Collection</option>
        {metadataFields.map((f) => (
          <option key={f.slug} value={`metadata.${f.slug}`}>
            metadata.{f.slug}
          </option>
        ))}
        {value === 'model' && <option value="model">model</option>}
      </select>
      {value !== 'model' && (
        <ChevronDown className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-muted-foreground" />
      )}
    </div>
  );
}

export function PatternBuilder({ segments, metadataFields, onChange }: PatternBuilderProps) {
  const addSegment = () => {
    // Insert before the last segment (which should be 'model')
    const newSeg: Segment = { id: newId(), kind: 'collection' };
    const insertAt = Math.max(0, segments.length - 1);
    const next = [...segments];
    next.splice(insertAt, 0, newSeg);
    onChange(next);
  };

  const removeSegment = (id: string) => {
    onChange(segments.filter((s) => s.id !== id));
  };

  const updateSegment = (id: string, kind: SegmentKind) => {
    onChange(segments.map((s) => (s.id === id ? { ...s, kind } : s)));
  };

  const pattern = segmentsToPattern(segments);
  const isValid = segments.length > 0 && segments[segments.length - 1].kind === 'model';

  return (
    <div className="space-y-3">
      {/* Visual breadcrumb builder */}
      <div className="flex flex-wrap items-center gap-2">
        {segments.map((seg, idx) => (
          <div key={seg.id} className="flex items-center gap-1.5">
            {idx > 0 && (
              <span className="text-muted-foreground text-sm select-none">/</span>
            )}
            <div
              className={cn(
                'flex items-center gap-1 rounded-md border px-2 py-1',
                seg.kind === 'model'
                  ? 'border-primary/40 bg-primary/5 text-primary'
                  : 'border-border bg-muted/40'
              )}
            >
              {seg.kind === 'model' ? (
                <span className="text-sm font-medium">model</span>
              ) : (
                <>
                  <SegmentSelect
                    value={seg.kind}
                    metadataFields={metadataFields}
                    onChange={(kind) => updateSegment(seg.id, kind)}
                  />
                  <button
                    onClick={() => removeSegment(seg.id)}
                    className="ml-0.5 text-muted-foreground hover:text-destructive transition-colors"
                    aria-label="Remove segment"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </>
              )}
            </div>
          </div>
        ))}

        <button
          onClick={addSegment}
          className="flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-1.5 text-xs text-muted-foreground hover:border-primary/60 hover:text-primary transition-colors"
        >
          <Plus className="h-3 w-3" />
          Add segment
        </button>
      </div>

      {/* Pattern preview */}
      <div className="rounded-md bg-muted/50 border border-border px-3 py-2">
        <span className="text-xs text-muted-foreground mr-2">Pattern:</span>
        <code className="text-xs font-mono text-foreground">{pattern}</code>
      </div>

      {!isValid && (
        <p className="text-xs text-destructive">Pattern must end with a {'{model}'} segment.</p>
      )}
    </div>
  );
}
