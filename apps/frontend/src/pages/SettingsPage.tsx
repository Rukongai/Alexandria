import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Lock, Filter, Eye } from 'lucide-react';
import type { MetadataFieldDetail } from '@alexandria/shared';
import { getFields, deleteField } from '../api/metadata';
import { useToast } from '../hooks/use-toast';
import { useDisplayPreferences, type AspectRatio } from '../hooks/use-display-preferences';
import { FieldDialog } from '../components/metadata/FieldDialog';
import { AlertDialog } from '../components/ui/alert-dialog';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Select } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';

const TYPE_LABELS: Record<string, string> = {
  text: 'Text',
  number: 'Number',
  boolean: 'Boolean',
  date: 'Date',
  url: 'URL',
  enum: 'Enum',
  multi_enum: 'Multi-select',
};

const ASPECT_RATIO_OPTIONS: { label: string; value: AspectRatio; description: string }[] = [
  { label: 'Square (1:1)', value: '1/1', description: 'Equal width and height' },
  { label: 'Portrait — Tall (2:3)', value: '2/3', description: 'Best for character/figure shots' },
  { label: 'Portrait — Standard (3:4)', value: '3/4', description: 'Common for cards and covers' },
  { label: 'Landscape (4:3)', value: '4/3', description: 'Current default — wider than tall' },
];

export function SettingsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { cardAspectRatio, setCardAspectRatio } = useDisplayPreferences();

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<MetadataFieldDetail | undefined>(undefined);
  const [deleteTarget, setDeleteTarget] = useState<MetadataFieldDetail | undefined>(undefined);

  const { data: fields, isLoading } = useQuery({
    queryKey: ['metadata-fields'],
    queryFn: getFields,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteField(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['metadata-fields'] });
      toast({ title: 'Field deleted' });
      setDeleteTarget(undefined);
    },
    onError: () => {
      toast({ title: 'Failed to delete field', variant: 'destructive' });
    },
  });

  return (
    <div className="flex flex-col gap-8 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage metadata fields and other library preferences.
        </p>
      </div>

      {/* Library Display section */}
      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">Library Display</h2>
          <p className="text-sm text-muted-foreground">
            Customize how model cards appear in the library grid.
          </p>
        </div>
        <div className="rounded-xl border p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <label htmlFor="card-aspect-ratio" className="text-sm font-medium text-foreground">
                Card Aspect Ratio
              </label>
              <p className="text-xs text-muted-foreground mt-0.5">
                {ASPECT_RATIO_OPTIONS.find((o) => o.value === cardAspectRatio)?.description}
              </p>
            </div>
            <Select
              id="card-aspect-ratio"
              value={cardAspectRatio}
              onChange={(e) => setCardAspectRatio(e.target.value as AspectRatio)}
              className="w-56"
            >
              {ASPECT_RATIO_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </section>

      {/* Metadata Fields section */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground">Metadata Fields</h2>
            <p className="text-sm text-muted-foreground">
              Define custom fields to organize and filter your models.
            </p>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-1.5" />
            Create Field
          </Button>
        </div>

        {/* Fields table */}
        <div className="rounded-xl border overflow-hidden">
          {isLoading ? (
            <div className="flex flex-col divide-y">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 px-4 py-3">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-4 w-16 ml-auto" />
                </div>
              ))}
            </div>
          ) : !fields || fields.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
              <p className="text-sm text-muted-foreground">No metadata fields yet.</p>
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4 mr-1.5" />
                Create your first field
              </Button>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="text-left font-medium text-muted-foreground px-4 py-2.5">Name</th>
                  <th className="text-left font-medium text-muted-foreground px-4 py-2.5">Type</th>
                  <th className="text-left font-medium text-muted-foreground px-4 py-2.5">Slug</th>
                  <th className="text-center font-medium text-muted-foreground px-4 py-2.5">
                    <span className="flex items-center justify-center gap-1">
                      <Filter className="h-3.5 w-3.5" />
                      Filter
                    </span>
                  </th>
                  <th className="text-center font-medium text-muted-foreground px-4 py-2.5">
                    <span className="flex items-center justify-center gap-1">
                      <Eye className="h-3.5 w-3.5" />
                      Browse
                    </span>
                  </th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {fields.map((field) => (
                  <FieldRow
                    key={field.id}
                    field={field}
                    onEdit={() => setEditTarget(field)}
                    onDelete={() => setDeleteTarget(field)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* Create dialog */}
      <FieldDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
      />

      {/* Edit dialog */}
      {editTarget && (
        <FieldDialog
          open={!!editTarget}
          onOpenChange={(open) => { if (!open) setEditTarget(undefined); }}
          field={editTarget}
        />
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <AlertDialog
          open={!!deleteTarget}
          onOpenChange={(open) => { if (!open) setDeleteTarget(undefined); }}
          title={`Delete "${deleteTarget.name}"?`}
          description="This field and all its values on every model will be permanently deleted."
          confirmLabel="Delete Field"
          destructive
          isLoading={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(deleteTarget.id)}
        />
      )}
    </div>
  );
}

interface FieldRowProps {
  field: MetadataFieldDetail;
  onEdit: () => void;
  onDelete: () => void;
}

function FieldRow({ field, onEdit, onDelete }: FieldRowProps) {
  return (
    <tr className="hover:bg-muted/20 transition-colors">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">{field.name}</span>
          {field.isDefault && (
            <span title="Default field — cannot be deleted">
              <Lock className="h-3.5 w-3.5 text-muted-foreground/60" />
            </span>
          )}
        </div>
      </td>
      <td className="px-4 py-3">
        <Badge variant="secondary" className="text-xs font-mono">
          {TYPE_LABELS[field.type] ?? field.type}
        </Badge>
      </td>
      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
        {field.slug}
      </td>
      <td className="px-4 py-3 text-center">
        {field.isFilterable ? (
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" title="Filterable" />
        ) : (
          <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground/30" title="Not filterable" />
        )}
      </td>
      <td className="px-4 py-3 text-center">
        {field.isBrowsable ? (
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" title="Browsable" />
        ) : (
          <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground/30" title="Not browsable" />
        )}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          {!field.isDefault && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive hover:text-destructive"
              onClick={onDelete}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}
