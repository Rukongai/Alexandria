import * as React from 'react';
import { Pencil, X, Plus, Check } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MetadataValue, SetModelMetadataRequest } from '@alexandria/shared';
import { setModelMetadata } from '../../api/metadata';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { toast } from '../../hooks/use-toast';

interface MetadataPanelProps {
  metadata: MetadataValue[];
  modelId: string;
}

type EditState = Record<string, string | string[]>;

function buildEditState(metadata: MetadataValue[]): EditState {
  const state: EditState = {};
  for (const m of metadata) {
    state[m.fieldSlug] = m.value;
  }
  return state;
}

function buildRequest(editState: EditState, metadata: MetadataValue[]): SetModelMetadataRequest {
  const req: SetModelMetadataRequest = {};
  for (const m of metadata) {
    const val = editState[m.fieldSlug];
    if (m.type === 'boolean') {
      req[m.fieldSlug] = val === 'true';
    } else if (m.type === 'number') {
      req[m.fieldSlug] = val ? Number(val) : null;
    } else if (m.type === 'multi_enum' || m.type === 'enum') {
      req[m.fieldSlug] = Array.isArray(val) ? val : [val as string].filter(Boolean);
    } else {
      req[m.fieldSlug] = (val as string) || null;
    }
  }
  return req;
}

interface TagInputProps {
  value: string[];
  onChange: (v: string[]) => void;
}

function TagInput({ value, onChange }: TagInputProps) {
  const [inputVal, setInputVal] = React.useState('');

  function addTag() {
    const trimmed = inputVal.trim();
    if (trimmed && !value.includes(trimmed)) {
      onChange([...value, trimmed]);
    }
    setInputVal('');
  }

  function removeTag(tag: string) {
    onChange(value.filter((t) => t !== tag));
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1">
        {value.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-full bg-secondary text-secondary-foreground px-2 py-0.5 text-xs font-medium"
          >
            {tag}
            <button
              onClick={() => removeTag(tag)}
              className="hover:text-foreground transition-colors"
              aria-label={`Remove ${tag}`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-1">
        <Input
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          placeholder="Add tag..."
          className="h-7 text-xs"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addTag();
            }
          }}
        />
        <Button variant="ghost" size="sm" onClick={addTag} className="h-7 px-2">
          <Plus className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

function MetadataDisplayValue({ field }: { field: MetadataValue }) {
  if (field.type === 'multi_enum' || field.type === 'enum') {
    const tags = Array.isArray(field.value) ? field.value : [field.value];
    return (
      <div className="flex flex-wrap gap-1">
        {tags.map((tag) => (
          <Badge key={tag} variant="secondary" className="text-xs">
            {tag}
          </Badge>
        ))}
      </div>
    );
  }

  if (field.type === 'boolean') {
    return (
      <span className="text-sm text-foreground">
        {field.value === 'true' ? 'Yes' : 'No'}
      </span>
    );
  }

  if (field.type === 'url') {
    return (
      <a
        href={field.value as string}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm text-primary hover:underline break-all"
      >
        {field.displayValue || (field.value as string)}
      </a>
    );
  }

  return <span className="text-sm text-foreground">{field.displayValue || (field.value as string)}</span>;
}

function EditFieldValue({
  field,
  value,
  onChange,
}: {
  field: MetadataValue;
  value: string | string[];
  onChange: (v: string | string[]) => void;
}) {
  if (field.type === 'multi_enum' || field.type === 'enum') {
    return (
      <TagInput
        value={Array.isArray(value) ? value : [value as string].filter(Boolean)}
        onChange={onChange}
      />
    );
  }

  if (field.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value === 'true'}
          onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
          className="h-4 w-4 rounded border-input accent-primary"
        />
        <span>{value === 'true' ? 'Yes' : 'No'}</span>
      </label>
    );
  }

  if (field.type === 'number') {
    return (
      <Input
        type="number"
        value={value as string}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 text-sm"
      />
    );
  }

  return (
    <Input
      type={field.type === 'url' ? 'url' : 'text'}
      value={value as string}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 text-sm"
    />
  );
}

export function MetadataPanel({ metadata, modelId }: MetadataPanelProps) {
  const [editing, setEditing] = React.useState(false);
  const [editState, setEditState] = React.useState<EditState>({});
  const queryClient = useQueryClient();

  function startEdit() {
    setEditState(buildEditState(metadata));
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setEditState({});
  }

  const mutation = useMutation({
    mutationFn: (req: SetModelMetadataRequest) => setModelMetadata(modelId, req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['model', modelId] });
      setEditing(false);
      setEditState({});
      toast({ title: 'Metadata saved' });
    },
    onError: () => {
      toast({ title: 'Failed to save metadata', variant: 'destructive' });
    },
  });

  function handleSave() {
    const req = buildRequest(editState, metadata);
    mutation.mutate(req);
  }

  if (metadata.length === 0 && !editing) {
    return (
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-foreground">Metadata</span>
        </div>
        <p className="text-sm text-muted-foreground">No metadata assigned.</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
        <span className="text-sm font-semibold text-foreground">Metadata</span>
        {!editing ? (
          <button
            onClick={startEdit}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Pencil className="h-3 w-3" />
            Edit
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs px-2"
              onClick={cancelEdit}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-6 text-xs px-2"
              onClick={handleSave}
              disabled={mutation.isPending}
            >
              <Check className="h-3 w-3 mr-1" />
              Save
            </Button>
          </div>
        )}
      </div>

      <div className="divide-y divide-border/60">
        {metadata.map((field) => (
          <div key={field.fieldSlug} className="px-4 py-2.5 flex gap-3">
            <span className="text-xs font-medium text-muted-foreground w-28 flex-shrink-0 pt-0.5 truncate">
              {field.fieldName}
            </span>
            <div className="flex-1 min-w-0">
              {editing ? (
                <EditFieldValue
                  field={field}
                  value={editState[field.fieldSlug] ?? field.value}
                  onChange={(v) =>
                    setEditState((prev) => ({ ...prev, [field.fieldSlug]: v }))
                  }
                />
              ) : (
                <MetadataDisplayValue field={field} />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
