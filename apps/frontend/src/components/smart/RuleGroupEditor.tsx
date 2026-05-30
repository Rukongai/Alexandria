import { Plus, FolderPlus, Trash2 } from 'lucide-react';
import type { MetadataFieldDetail } from '@alexandria/shared';
import { SMART_COLLECTION_MAX_DEPTH } from '@alexandria/shared';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { ConditionRow } from './ConditionRow';
import type { DraftGroup, useSmartCollectionDraft } from '../../hooks/use-smart-collection-draft';

type Draft = ReturnType<typeof useSmartCollectionDraft>;

interface Props {
  node: DraftGroup;
  fields: MetadataFieldDetail[];
  draft: Draft;
  depth: number;
  isRoot?: boolean;
  onRemove?: () => void;
}

/** Recursive editor for one rule group (AND/OR over its children). */
export function RuleGroupEditor({ node, fields, draft, depth, isRoot = false, onRemove }: Props) {
  const canNest = depth < SMART_COLLECTION_MAX_DEPTH;

  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        isRoot ? 'border-border bg-card' : 'border-dashed border-border/70 bg-muted/30',
      )}
    >
      <div className="mb-3 flex items-center gap-2">
        <MatchToggle op={node.op} onChange={(op) => draft.setGroupOp(node._id, op)} />
        <span className="text-xs text-muted-foreground">
          Match {node.op === 'and' ? 'all' : 'any'} of the following
        </span>
        <div className="flex-1" />
        {!isRoot && onRemove && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onRemove}
            aria-label="Remove group"
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {node.children.length === 0 && (
          <p className="px-1 py-2 text-sm text-muted-foreground">
            No rules yet — this {isRoot ? 'collection matches every model' : 'group is empty'}.
          </p>
        )}
        {node.children.map((child) =>
          child.kind === 'group' ? (
            <RuleGroupEditor
              key={child._id}
              node={child}
              fields={fields}
              draft={draft}
              depth={depth + 1}
              onRemove={() => draft.remove(child._id)}
            />
          ) : (
            <ConditionRow
              key={child._id}
              node={child}
              fields={fields}
              onChange={(patch) => draft.updateCondition(child._id, patch)}
              onRemove={() => draft.remove(child._id)}
            />
          ),
        )}
      </div>

      <div className="mt-3 flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => draft.addCondition(node._id)}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Add rule
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => draft.addGroup(node._id)}
          disabled={!canNest}
          title={canNest ? undefined : `Maximum nesting depth is ${SMART_COLLECTION_MAX_DEPTH}`}
        >
          <FolderPlus className="mr-1 h-3.5 w-3.5" /> Add group
        </Button>
      </div>
    </div>
  );
}

function MatchToggle({ op, onChange }: { op: 'and' | 'or'; onChange: (op: 'and' | 'or') => void }) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-input">
      {(['and', 'or'] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={op === value}
          onClick={() => onChange(value)}
          className={cn(
            'px-2.5 py-1 text-xs font-medium transition-colors',
            op === value ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-accent',
          )}
        >
          {value.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
