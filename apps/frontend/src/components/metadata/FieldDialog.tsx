import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import type {
  MetadataFieldDetail,
  MetadataFieldType,
  CreateMetadataFieldRequest,
  UpdateMetadataFieldRequest,
} from '@alexandria/shared';
import { createField, updateField } from '../../api/metadata';
import { useToast } from '../../hooks/use-toast';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

const FIELD_TYPES: { value: MetadataFieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'date', label: 'Date' },
  { value: 'url', label: 'URL' },
  { value: 'enum', label: 'Enum (single)' },
  { value: 'multi_enum', label: 'Multi-select' },
];

interface FieldDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  field?: MetadataFieldDetail;
  onSuccess?: () => void;
}

export function FieldDialog({ open, onOpenChange, field, onSuccess }: FieldDialogProps) {
  const isEdit = !!field;
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [name, setName] = useState('');
  const [type, setType] = useState<MetadataFieldType>('text');
  const [isFilterable, setIsFilterable] = useState(false);
  const [isBrowsable, setIsBrowsable] = useState(false);
  const [enumOptions, setEnumOptions] = useState<string[]>([]);
  const [newOption, setNewOption] = useState('');

  useEffect(() => {
    if (open) {
      setName(field?.name ?? '');
      setType(field?.type ?? 'text');
      setIsFilterable(field?.isFilterable ?? false);
      setIsBrowsable(field?.isBrowsable ?? false);
      setEnumOptions(field?.config?.enumOptions ?? []);
      setNewOption('');
    }
  }, [open, field]);

  const createMutation = useMutation({
    mutationFn: (data: CreateMetadataFieldRequest) => createField(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['metadata-fields'] });
      toast({ title: 'Field created' });
      onOpenChange(false);
      onSuccess?.();
    },
    onError: () => {
      toast({ title: 'Failed to create field', variant: 'destructive' });
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: UpdateMetadataFieldRequest) => updateField(field!.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['metadata-fields'] });
      toast({ title: 'Field updated' });
      onOpenChange(false);
      onSuccess?.();
    },
    onError: () => {
      toast({ title: 'Failed to update field', variant: 'destructive' });
    },
  });

  const isLoading = createMutation.isPending || updateMutation.isPending;
  const showEnumConfig = type === 'enum' || type === 'multi_enum';

  function addOption() {
    const trimmed = newOption.trim();
    if (!trimmed || enumOptions.includes(trimmed)) return;
    setEnumOptions((prev) => [...prev, trimmed]);
    setNewOption('');
  }

  function removeOption(option: string) {
    setEnumOptions((prev) => prev.filter((o) => o !== option));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    const config = showEnumConfig && enumOptions.length > 0
      ? { enumOptions }
      : undefined;

    if (isEdit) {
      updateMutation.mutate({ name: name.trim(), isFilterable, isBrowsable, config });
    } else {
      createMutation.mutate({
        name: name.trim(),
        type,
        isFilterable,
        isBrowsable,
        config,
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Field' : 'New Metadata Field'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="field-name">Name</Label>
            <Input
              id="field-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Designer, Scale, Filament Type"
              required
              autoFocus
            />
          </div>

          {!isEdit && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="field-type">Type</Label>
              <select
                id="field-type"
                value={type}
                onChange={(e) => setType(e.target.value as MetadataFieldType)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">Type cannot be changed after creation.</p>
            </div>
          )}

          {isEdit && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 rounded-md px-3 py-2">
              <span className="font-medium">Type:</span>
              <span>{FIELD_TYPES.find((t) => t.value === field!.type)?.label ?? field!.type}</span>
            </div>
          )}

          {/* Enum options config */}
          {showEnumConfig && (
            <div className="flex flex-col gap-2">
              <Label>Options</Label>
              {enumOptions.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {enumOptions.map((opt) => (
                    <span
                      key={opt}
                      className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium"
                    >
                      {opt}
                      <button
                        type="button"
                        onClick={() => removeOption(opt)}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <Input
                  value={newOption}
                  onChange={(e) => setNewOption(e.target.value)}
                  placeholder="Add option..."
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addOption();
                    }
                  }}
                  className="flex-1"
                />
                <Button type="button" variant="outline" size="icon" onClick={addOption}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}

          {/* Toggles */}
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={isFilterable}
                onChange={(e) => setIsFilterable(e.target.checked)}
                className="rounded border-input"
              />
              <span className="text-sm">Filterable</span>
              <span className="text-xs text-muted-foreground">(appears in filter panel)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={isBrowsable}
                onChange={(e) => setIsBrowsable(e.target.checked)}
                className="rounded border-input"
              />
              <span className="text-sm">Browsable</span>
              <span className="text-xs text-muted-foreground">(shown on model cards)</span>
            </label>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading || !name.trim()}>
              {isLoading ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Field'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
