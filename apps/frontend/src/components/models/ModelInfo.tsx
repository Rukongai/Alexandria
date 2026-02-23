import * as React from 'react';
import { Check, Pencil, X } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ModelDetail } from '@alexandria/shared';
import { updateModel } from '../../api/models';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { formatFileSize, formatDate } from '../../lib/format';
import { toast } from '../../hooks/use-toast';

interface ModelInfoProps {
  model: ModelDetail;
}

const STATUS_LABELS: Record<string, string> = {
  ready: 'Ready',
  processing: 'Processing',
  error: 'Error',
};

const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'destructive' | 'outline' | 'accent'> = {
  ready: 'default',
  processing: 'accent',
  error: 'destructive',
};

const SOURCE_LABELS: Record<string, string> = {
  zip_upload: 'ZIP Upload',
  folder_import: 'Folder Import',
  manual: 'Manual',
};

export function ModelInfo({ model }: ModelInfoProps) {
  const queryClient = useQueryClient();

  const [editingName, setEditingName] = React.useState(false);
  const [editingDesc, setEditingDesc] = React.useState(false);
  const [nameVal, setNameVal] = React.useState(model.name);
  const [descVal, setDescVal] = React.useState(model.description ?? '');

  // Keep local state in sync when model data changes
  React.useEffect(() => {
    if (!editingName) setNameVal(model.name);
  }, [model.name, editingName]);

  React.useEffect(() => {
    if (!editingDesc) setDescVal(model.description ?? '');
  }, [model.description, editingDesc]);

  const mutation = useMutation({
    mutationFn: (data: { name?: string; description?: string | null }) =>
      updateModel(model.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['model', model.id] });
      setEditingName(false);
      setEditingDesc(false);
      toast({ title: 'Model updated' });
    },
    onError: () => {
      toast({ title: 'Failed to update model', variant: 'destructive' });
    },
  });

  function saveName() {
    if (nameVal.trim() && nameVal.trim() !== model.name) {
      mutation.mutate({ name: nameVal.trim() });
    } else {
      setEditingName(false);
    }
  }

  function saveDesc() {
    const next = descVal.trim() || null;
    if (next !== model.description) {
      mutation.mutate({ description: next });
    } else {
      setEditingDesc(false);
    }
  }

  function cancelName() {
    setNameVal(model.name);
    setEditingName(false);
  }

  function cancelDesc() {
    setDescVal(model.description ?? '');
    setEditingDesc(false);
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-4 pt-4 pb-3 border-b border-border/60">
        {/* Name */}
        {editingName ? (
          <div className="flex items-center gap-2">
            <Input
              value={nameVal}
              onChange={(e) => setNameVal(e.target.value)}
              className="text-lg font-semibold h-auto py-1"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveName();
                if (e.key === 'Escape') cancelName();
              }}
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 flex-shrink-0"
              onClick={saveName}
              disabled={mutation.isPending}
            >
              <Check className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 flex-shrink-0"
              onClick={cancelName}
              disabled={mutation.isPending}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <div className="flex items-start gap-2 group">
            <h1 className="text-xl font-semibold text-foreground leading-snug flex-1">
              {model.name}
            </h1>
            <button
              onClick={() => setEditingName(true)}
              className="opacity-0 group-hover:opacity-100 mt-0.5 p-1 rounded hover:bg-muted transition-all text-muted-foreground hover:text-foreground"
              aria-label="Edit name"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Description */}
        <div className="mt-2">
          {editingDesc ? (
            <div className="flex flex-col gap-2">
              <textarea
                value={descVal}
                onChange={(e) => setDescVal(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
                rows={3}
                placeholder="Add a description..."
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Escape') cancelDesc();
                }}
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={cancelDesc}
                  disabled={mutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  onClick={saveDesc}
                  disabled={mutation.isPending}
                >
                  Save
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2 group">
              {model.description ? (
                <p className="text-sm text-muted-foreground flex-1 leading-relaxed">
                  {model.description}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground/50 italic flex-1">
                  No description
                </p>
              )}
              <button
                onClick={() => setEditingDesc(true)}
                className="opacity-0 group-hover:opacity-100 mt-0.5 p-1 rounded hover:bg-muted transition-all text-muted-foreground hover:text-foreground flex-shrink-0"
                aria-label="Edit description"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="px-4 py-3 flex flex-col gap-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Status</span>
          <Badge variant={STATUS_VARIANTS[model.status] ?? 'secondary'}>
            {STATUS_LABELS[model.status] ?? model.status}
          </Badge>
        </div>

        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Source</span>
          <Badge variant="outline">{SOURCE_LABELS[model.sourceType] ?? model.sourceType}</Badge>
        </div>

        {model.originalFilename && (
          <div className="flex items-start justify-between text-sm gap-2">
            <span className="text-muted-foreground flex-shrink-0">Original file</span>
            <span className="text-foreground text-right truncate max-w-[200px] font-mono text-xs">
              {model.originalFilename}
            </span>
          </div>
        )}

        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Files</span>
          <span className="text-foreground">{model.fileCount} files</span>
        </div>

        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Total size</span>
          <span className="text-foreground">{formatFileSize(model.totalSizeBytes)}</span>
        </div>

        <div className="h-px bg-border/60 my-0.5" />

        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Added</span>
          <span className="text-foreground">{formatDate(model.createdAt)}</span>
        </div>

        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Updated</span>
          <span className="text-foreground">{formatDate(model.updatedAt)}</span>
        </div>
      </div>
    </div>
  );
}
