import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, FolderOpen, User } from 'lucide-react';
import type { DetectedImportMetadata, BatchUploadMetadata } from '@alexandria/shared';
import { getCollections } from '../../api/collections';
import { getFieldValues } from '../../api/metadata';
import { useCommitSession } from '../../hooks/use-import-sessions';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Checkbox } from '../ui/checkbox';
import { Textarea } from '../ui/textarea';
import { TagAutocomplete } from '../metadata/tag-autocomplete';

interface BatchMetadataFormProps {
  sessionId: string;
  originalFilename: string;
  detected: DetectedImportMetadata;
  onCommitted: (modelId: string) => void;
}

interface FormState {
  modelName: string;
  description: string;
  collectionId: string;
  newCollectionName: string;
  artist: string;
  tags: string[];
  tagInput: string;
  markPreSupported: boolean;
  autoThumbnails: boolean;
  markNsfw: boolean;
  skipDuplicatesByHash: boolean;
}

function archiveName(filename: string): string {
  return filename.replace(/\.(tar\.gz|zip|rar|7z)$/i, '').trim() || filename;
}

function createInitialForm(detected: DetectedImportMetadata, originalFilename: string): FormState {
  const seenTags = new Set<string>();
  const tags = detected.tagsGuessed.reduce<string[]>((result, rawTag) => {
    const tag = rawTag.trim();
    const key = tag.toLowerCase();
    if (!key || seenTags.has(key)) return result;
    seenTags.add(key);
    result.push(tag);
    return result;
  }, []);

  return {
    modelName: archiveName(originalFilename),
    description: '',
    collectionId: '',
    newCollectionName: '',
    artist: detected.artist ?? '',
    tags,
    tagInput: '',
    markPreSupported: false,
    autoThumbnails: true,
    markNsfw: false,
    skipDuplicatesByHash: true,
  };
}

export function BatchMetadataForm({
  sessionId,
  originalFilename,
  detected,
  onCommitted,
}: BatchMetadataFormProps) {
  const [form, setForm] = useState<FormState>(() => createInitialForm(detected, originalFilename));

  useEffect(() => {
    setForm(createInitialForm(detected, originalFilename));
  }, [sessionId]);

  const { data: collections } = useQuery({
    queryKey: ['collections', { depth: 1 }],
    queryFn: () => getCollections({ depth: 1 }).then((response) => response.data),
    staleTime: 30_000,
  });
  const availableCollections = collections ?? [];

  const { data: tagSuggestions = [] } = useQuery({
    queryKey: ['field-values', 'tags'],
    queryFn: () => getFieldValues('tags'),
    staleTime: 60_000,
  });

  const commitMutation = useCommitSession();

  async function handleSubmit() {
    // collectionId and newCollectionName are mutually exclusive: if an existing
    // collection is selected, don't also send newCollectionName.
    const hasExistingCollection = !!form.collectionId && form.collectionId !== '__new__';
    const modelName = form.modelName.trim();
    const description = form.description.trim();
    const batchMetadata: BatchUploadMetadata = {
      modelName,
      description: description || null,
      ...(hasExistingCollection ? { collectionId: form.collectionId } : {}),
      ...(!hasExistingCollection && form.newCollectionName.trim()
        ? { newCollectionName: form.newCollectionName.trim() }
        : {}),
      ...(form.artist.trim() ? { artist: form.artist.trim() } : {}),
      ...(form.tags.length > 0 ? { tags: form.tags } : {}),
      options: {
        markPreSupported: form.markPreSupported,
        autoThumbnails: form.autoThumbnails,
        markNsfw: form.markNsfw,
        // skipDuplicatesByHash is sent as false — dedup by hash is not yet implemented.
        skipDuplicatesByHash: false,
      },
    };

    try {
      const result = await commitMutation.mutateAsync({ id: sessionId, batchMetadata });
      onCommitted(result.modelId);
    } catch {
      // Error surfaces via commitMutation.error
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* Model details */}
      <FormSection label="Model details">
        <div className="flex flex-col gap-2">
          <Input
            value={form.modelName}
            onChange={(e) => setForm((f) => ({ ...f, modelName: e.target.value }))}
            placeholder="Model name"
            maxLength={255}
            className="text-[13px]"
          />
          <Textarea
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            placeholder="Description (optional)"
            maxLength={2000}
            className="min-h-[88px] text-[13px]"
          />
        </div>
      </FormSection>

      {/* Destination collection */}
      <FormSection label="Destination collection">
        <select
          value={form.collectionId}
          onChange={(e) =>
            setForm((f) => ({
              ...f,
              collectionId: e.target.value,
              newCollectionName: e.target.value !== '__new__' ? '' : f.newCollectionName,
            }))
          }
          className="w-full rounded-lg px-3 py-2 text-[13px]"
          style={{
            background: 'var(--ax-bg-elev)',
            border: '1px solid var(--ax-border)',
            color: 'var(--ax-fg)',
            fontFamily: 'inherit',
          }}
        >
          <option value="">— None —</option>
          {availableCollections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
          <option value="__new__">+ New collection…</option>
        </select>
        {form.collectionId === '__new__' && (
          <div className="flex items-center gap-2 mt-2">
            <FolderOpen className="h-4 w-4 flex-shrink-0" style={{ color: 'var(--ax-amber)' }} />
            <Input
              placeholder="New collection name"
              value={form.newCollectionName}
              onChange={(e) => setForm((f) => ({ ...f, newCollectionName: e.target.value }))}
              className="text-[13px]"
            />
          </div>
        )}
      </FormSection>

      {/* Artist */}
      <FormSection
        label={
          <span>
            Artist
            {detected.artist && (
              <span
                className="ml-2 font-normal text-[11px]"
                style={{ color: 'var(--ax-fg-subtle)' }}
              >
                auto-detected
              </span>
            )}
          </span>
        }
      >
        <div className="flex items-center gap-2">
          <User className="h-4 w-4 flex-shrink-0" style={{ color: 'var(--ax-fg-muted)' }} />
          <Input
            value={form.artist}
            onChange={(e) => setForm((f) => ({ ...f, artist: e.target.value }))}
            placeholder="Artist name (optional)"
            maxLength={255}
            className="text-[13px]"
          />
        </div>
      </FormSection>

      {/* Tags */}
      <FormSection label="Tags to apply to all">
        <div
          className="rounded-lg p-2.5 min-h-[40px]"
          style={{
            background: 'var(--ax-bg-elev)',
            border: '1px solid var(--ax-border)',
          }}
        >
          <TagAutocomplete
            value={form.tags}
            onChange={(tags) => setForm((f) => ({ ...f, tags }))}
            inputValue={form.tagInput}
            onInputChange={(tagInput) => setForm((f) => ({ ...f, tagInput }))}
            suggestions={tagSuggestions}
            placeholder={form.tags.length === 0 ? 'Type a tag and press Enter…' : '+ tag'}
            inputAriaLabel="Tag name"
            chipClassName="ax-chip ax-chip-amber h-[22px] rounded-md"
            inputClassName="h-7 min-w-[80px] border-0 bg-transparent px-1 text-[12px] shadow-none focus-visible:ring-0"
          />
        </div>
        <p className="text-[11.5px] mt-1.5" style={{ color: 'var(--ax-fg-muted)' }}>
          Inferred from filenames + folder paths. Press Enter or comma to add.
        </p>
      </FormSection>

      {/* Options */}
      <FormSection label="Options">
        <div className="flex flex-col gap-1">
          <OptionCheck
            id="pre-supported"
            label="Mark all as pre-supported"
            checked={form.markPreSupported}
            onChange={(v) => setForm((f) => ({ ...f, markPreSupported: v }))}
          />
          <OptionCheck
            id="auto-thumbnails"
            label="Auto-generate thumbnails"
            checked={form.autoThumbnails}
            onChange={(v) => setForm((f) => ({ ...f, autoThumbnails: v }))}
            note="Always runs during ingestion"
          />
          <OptionCheck
            id="mark-nsfw"
            label="Mark as NSFW"
            checked={form.markNsfw}
            onChange={(v) => setForm((f) => ({ ...f, markNsfw: v }))}
          />
          <OptionCheck
            id="skip-dupes"
            label="Skip duplicates (by hash)"
            checked={false}
            onChange={() => {}}
            disabled
            note="coming soon"
          />
        </div>
      </FormSection>

      {/* Commit error */}
      {commitMutation.error && (
        <div
          className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-[13px]"
          style={{
            background: 'color-mix(in srgb, var(--ax-danger) 10%, transparent)',
            border: '1px solid var(--ax-danger)',
            color: 'var(--ax-danger)',
          }}
        >
          {commitMutation.error instanceof Error
            ? commitMutation.error.message
            : 'Commit failed. Please try again.'}
        </div>
      )}

      <Button
        onClick={handleSubmit}
        disabled={commitMutation.isPending || form.modelName.trim().length === 0}
        className="w-full font-semibold"
        style={{
          background: 'var(--ax-amber)',
          color: 'var(--ax-amber-fg)',
          border: 'none',
        }}
      >
        {commitMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
        Import {detected.modelCount > 0 ? `${detected.modelCount} models` : 'archive'}
      </Button>
    </div>
  );
}

function FormSection({
  label,
  children,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label
        className="block text-[11px] font-semibold uppercase mb-1.5"
        style={{
          color: 'var(--ax-fg-muted)',
          letterSpacing: '0.06em',
        }}
      >
        {label}
      </Label>
      {children}
    </div>
  );
}

function OptionCheck({
  id,
  label,
  checked,
  onChange,
  note,
  disabled,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  note?: string;
  disabled?: boolean;
}) {
  return (
    <label
      htmlFor={id}
      className={`flex items-center gap-2.5 py-1.5 px-1 rounded ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <Checkbox
        id={id}
        checked={checked}
        onChange={(e) => !disabled && onChange(e.target.checked)}
        disabled={disabled}
      />
      <span className="text-[12.5px]" style={{ color: checked && !disabled ? 'var(--ax-fg)' : 'var(--ax-fg-muted)' }}>
        {label}
        {note && (
          <span className="ml-1.5 text-[11px]" style={{ color: 'var(--ax-fg-subtle)' }}>
            ({note})
          </span>
        )}
      </span>
    </label>
  );
}
