import * as React from 'react';
import { Pencil, X, Plus, Check } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MetadataValue, MetadataFieldDetail, MetadataFieldType, SetModelMetadataRequest } from '@alexandria/shared';
import { setModelMetadata, getFields } from '../../api/metadata';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { toast } from '../../hooks/use-toast';

interface MetadataPanelProps {
  metadata: MetadataValue[];
  modelId: string;
}

export type EditState = Record<string, string | string[]>;

/** An "editable field" — either from existing metadata or from an unassigned field definition. */
export interface EditableField {
  fieldSlug: string;
  fieldName: string;
  type: MetadataFieldType;
  enumOptions?: string[];
  isDefault?: boolean;
}

export function defaultValueForType(type: MetadataFieldType): string | string[] {
  if (type === 'multi_enum') return [];
  if (type === 'boolean') return 'false';
  return '';
}

export function buildEditState(metadata: MetadataValue[], unassigned: EditableField[]): EditState {
  const state: EditState = {};
  for (const m of metadata) {
    state[m.fieldSlug] = m.value;
  }
  for (const f of unassigned) {
    state[f.fieldSlug] = defaultValueForType(f.type);
  }
  return state;
}

export function buildRequest(editState: EditState, fields: EditableField[], initialState: EditState): SetModelMetadataRequest {
  const req: SetModelMetadataRequest = {};
  for (const f of fields) {
    const val = editState[f.fieldSlug];
    const initial = initialState[f.fieldSlug];
    // Skip fields the user never touched
    if (JSON.stringify(val) === JSON.stringify(initial)) continue;

    if (f.type === 'boolean') {
      req[f.fieldSlug] = val === 'true';
    } else if (f.type === 'number') {
      req[f.fieldSlug] = (val as string) !== '' ? Number(val) : null;
    } else if (f.type === 'multi_enum') {
      const arr = Array.isArray(val) ? val : [val as string].filter(Boolean);
      req[f.fieldSlug] = arr.length > 0 ? arr : null;
    } else if (f.type === 'enum') {
      const v = Array.isArray(val) ? val[0] ?? null : (val as string) || null;
      req[f.fieldSlug] = v;
    } else {
      req[f.fieldSlug] = (val as string) || null;
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

/** Constrained multi-select from enum options (checkboxes + tags). */
function EnumMultiSelect({
  value,
  options,
  onChange,
}: {
  value: string[];
  options: string[];
  onChange: (v: string[]) => void;
}) {
  function toggle(opt: string) {
    if (value.includes(opt)) {
      onChange(value.filter((v) => v !== opt));
    } else {
      onChange([...value, opt]);
    }
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => toggle(opt)}
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors border ${
            value.includes(opt)
              ? 'bg-primary text-primary-foreground border-primary'
              : 'bg-secondary text-secondary-foreground border-transparent hover:bg-secondary/80'
          }`}
        >
          {opt}
        </button>
      ))}
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
  field: EditableField;
  value: string | string[];
  onChange: (v: string | string[]) => void;
}) {
  const enumOptions = field.enumOptions;

  if (field.type === 'multi_enum') {
    // Free-text tags for the default "tags" field; constrained options for custom multi_enum fields
    if (enumOptions && enumOptions.length > 0 && !field.isDefault) {
      return (
        <EnumMultiSelect
          value={Array.isArray(value) ? value : [value as string].filter(Boolean)}
          options={enumOptions}
          onChange={onChange}
        />
      );
    }
    return (
      <TagInput
        value={Array.isArray(value) ? value : [value as string].filter(Boolean)}
        onChange={onChange}
      />
    );
  }

  if (field.type === 'enum') {
    if (enumOptions && enumOptions.length > 0) {
      return (
        <Select
          value={Array.isArray(value) ? value[0] ?? '' : (value as string)}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 text-sm"
        >
          <option value="">Select...</option>
          {enumOptions.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </Select>
      );
    }
    // Fallback to tags if no options defined
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

  if (field.type === 'date') {
    return (
      <Input
        type="date"
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
  const initialEditState = React.useRef<EditState>({});
  const queryClient = useQueryClient();

  // Fetch all field definitions when in edit mode
  const { data: allFields } = useQuery({
    queryKey: ['metadata-fields'],
    queryFn: getFields,
    enabled: editing,
  });

  const assignedSlugs = new Set(metadata.map((m) => m.fieldSlug));

  // Build editableFields list from field definitions (preserving order)
  const assignedFields: EditableField[] = metadata.map((m) => {
    const def = allFields?.find((f) => f.slug === m.fieldSlug);
    return {
      fieldSlug: m.fieldSlug,
      fieldName: m.fieldName,
      type: m.type,
      enumOptions: def?.config?.enumOptions,
      isDefault: def?.isDefault,
    };
  });

  const unassignedFields: EditableField[] = (allFields ?? [])
    .filter((f) => !assignedSlugs.has(f.slug))
    .map((f) => ({
      fieldSlug: f.slug,
      fieldName: f.name,
      type: f.type,
      enumOptions: f.config?.enumOptions,
      isDefault: f.isDefault,
    }));

  const allEditableFields = [...assignedFields, ...unassignedFields];

  function startEdit() {
    const state = buildEditState(metadata, []);
    initialEditState.current = state;
    setEditState(state);
    setEditing(true);
  }

  // Re-sync edit state when field definitions load (adds unassigned fields)
  React.useEffect(() => {
    if (editing && allFields) {
      setEditState((prev) => {
        const next = { ...prev };
        for (const f of unassignedFields) {
          if (!(f.fieldSlug in next)) {
            const def = defaultValueForType(f.type);
            next[f.fieldSlug] = def;
            initialEditState.current[f.fieldSlug] = def;
          }
        }
        return next;
      });
    }
    // Safe: unassignedFields derives from allFields (in deps). metadata won't change during edit mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, allFields]);

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
    const req = buildRequest(editState, allEditableFields, initialEditState.current);
    mutation.mutate(req);
  }

  if (metadata.length === 0 && !editing) {
    return (
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-foreground">Metadata</span>
          <button
            onClick={startEdit}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Pencil className="h-3 w-3" />
            Edit
          </button>
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
        {(editing ? allEditableFields : assignedFields).map((field) => (
          <div key={field.fieldSlug} className="px-4 py-2.5 flex gap-3">
            <span className="text-xs font-medium text-muted-foreground w-28 flex-shrink-0 pt-0.5 truncate">
              {field.fieldName}
            </span>
            <div className="flex-1 min-w-0">
              {editing ? (
                <EditFieldValue
                  field={field}
                  value={editState[field.fieldSlug] ?? ''}
                  onChange={(v) =>
                    setEditState((prev) => ({ ...prev, [field.fieldSlug]: v }))
                  }
                />
              ) : (
                <MetadataDisplayValue field={metadata.find((m) => m.fieldSlug === field.fieldSlug)!} />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
