import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, FolderOpen, User } from 'lucide-react';
import type { DetectedImportMetadata, BatchUploadMetadata } from '@alexandria/shared';
import { getCollections } from '../../api/collections';
import { getFields, getFieldValues } from '../../api/metadata';
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
  draftMetadata?: BatchUploadMetadata | null;
  /** Changes only when server-provided defaults should replace local edits. */
  resetKey?: string;
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
  metadata: NonNullable<BatchUploadMetadata['metadata']>;
  metadataTypes: Record<string, 'array' | 'boolean' | 'number' | 'string'>;
}

function archiveName(filename: string): string {
  return filename.replace(/\.(tar\.gz|zip|rar|7z)$/i, '').trim() || filename;
}

/**
 * Pick the collection destination from the first source that names one.
 *
 * `DetectedMetadataFile` carries no `collectionId` by design — a UUID from
 * another library would render as a blank picker and then be submitted anyway.
 */
function resolveCollection(
  draftMetadata: BatchUploadMetadata | null | undefined,
  fromFile: DetectedImportMetadata['metadataFile'],
): Pick<FormState, 'collectionId' | 'newCollectionName'> {
  // The draft is the reviewer's own pick and wins outright, either way round.
  if (draftMetadata?.newCollectionName) {
    return { collectionId: '__new__', newCollectionName: draftMetadata.newCollectionName };
  }
  if (draftMetadata?.collectionId) {
    return { collectionId: draftMetadata.collectionId, newCollectionName: '' };
  }
  // Only newCollectionName is read from the archive; a collectionId is never
  // honoured even if one reaches us, since the picker cannot display it.
  if (fromFile?.newCollectionName) {
    return { collectionId: '__new__', newCollectionName: fromFile.newCollectionName };
  }
  return { collectionId: '', newCollectionName: '' };
}

function createInitialForm(
  detected: DetectedImportMetadata,
  originalFilename: string,
  draftMetadata?: BatchUploadMetadata | null,
): FormState {
  // An explicit metadata.json in the archive beats the scan's heuristics, but a
  // saved draft beats both: it is the reviewer's own intent.
  const fromFile = detected.metadataFile;

  const seenTags = new Set<string>();
  const sourceTags = draftMetadata?.tags ?? fromFile?.tags ?? detected.tagsGuessed;
  const tags = sourceTags.reduce<string[]>((result, rawTag) => {
    const tag = rawTag.trim();
    const key = tag.toLowerCase();
    if (!key || seenTags.has(key)) return result;
    seenTags.add(key);
    result.push(tag);
    return result;
  }, []);

  // The two collection fields are one choice, so they resolve as a pair. Taking
  // them field-by-field lets a draft's existing collection lose to a file's new
  // one, silently discarding the reviewer's own pick.
  const collection = resolveCollection(draftMetadata, fromFile);

  const metadata = { ...(draftMetadata?.metadata ?? fromFile?.metadata ?? {}) };
  const metadataTypes = Object.fromEntries(
    Object.entries(metadata).map(([field, value]) => [
      field,
      Array.isArray(value) ? 'array' : typeof value === 'boolean'
        ? 'boolean' : typeof value === 'number' ? 'number' : 'string',
    ]),
  ) as FormState['metadataTypes'];

  return {
    modelName:
      draftMetadata?.modelName ?? fromFile?.modelName ?? archiveName(originalFilename),
    description: draftMetadata?.description ?? fromFile?.description ?? '',
    ...collection,
    artist: draftMetadata?.artist ?? fromFile?.artist ?? detected.artist ?? '',
    tags,
    tagInput: '',
    markPreSupported: draftMetadata?.options?.markPreSupported ?? false,
    autoThumbnails: draftMetadata?.options?.autoThumbnails ?? true,
    markNsfw: draftMetadata?.options?.markNsfw ?? false,
    skipDuplicatesByHash: draftMetadata?.options?.skipDuplicatesByHash ?? true,
    metadata,
    metadataTypes,
  };
}

/**
 * An archive metadata file often uses an empty string for an unknown optional
 * value (for example, `url: ""`). Metadata fields such as URL and number do
 * not accept that placeholder, so omit it rather than turning a prefill into
 * a failed import. `null` is intentionally retained because it means clear
 * this value when a saved draft explicitly includes it.
 */
function omitBlankMetadataValues(
  metadata: NonNullable<BatchUploadMetadata['metadata']>,
): NonNullable<BatchUploadMetadata['metadata']> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => (
      typeof value !== 'string' || value.trim().length > 0
    )),
  );
}

/** Where a prefilled field's value came from, for the review-form badges. */
type FieldSource = 'file' | 'detected' | null;

function fieldSources(
  detected: DetectedImportMetadata,
  draftMetadata?: BatchUploadMetadata | null,
): Record<'modelName' | 'artist' | 'tags', FieldSource> {
  const fromFile = detected.metadataFile;
  const pick = (
    drafted: unknown,
    file: unknown,
    guessed: unknown,
  ): FieldSource => {
    // A draft is the reviewer's own value, so it carries no provenance badge.
    if (drafted !== undefined && drafted !== null) return null;
    if (file !== undefined && file !== null) return 'file';
    return guessed ? 'detected' : null;
  };

  return {
    modelName: pick(draftMetadata?.modelName, fromFile?.modelName, null),
    artist: pick(draftMetadata?.artist, fromFile?.artist, detected.artist),
    tags: pick(
      draftMetadata?.tags,
      fromFile?.tags,
      detected.tagsGuessed.length > 0 || null,
    ),
  };
}

function SourceBadge({ source }: { source: FieldSource }) {
  if (!source) return null;
  return (
    <span
      className="ml-2 font-normal text-[11px]"
      style={{ color: 'var(--ax-fg-subtle)' }}
    >
      {source === 'file' ? 'from metadata.json' : 'auto-detected'}
    </span>
  );
}

export function BatchMetadataForm({
  sessionId,
  originalFilename,
  detected,
  draftMetadata,
  resetKey = sessionId,
  onCommitted,
}: BatchMetadataFormProps) {
  const sources = fieldSources(detected, draftMetadata);
  const initialFormRef = useRef(createInitialForm(detected, originalFilename, draftMetadata));
  initialFormRef.current = createInitialForm(detected, originalFilename, draftMetadata);
  const [form, setForm] = useState<FormState>(() => initialFormRef.current);

  useEffect(() => {
    setForm(initialFormRef.current);
  }, [resetKey]);

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
  const { data: metadataFields = [] } = useQuery({
    queryKey: ['metadata-fields'],
    queryFn: getFields,
    staleTime: 60_000,
  });
  const metadataFieldNames = new Map(metadataFields.map((field) => [field.slug, field.name]));

  const commitMutation = useCommitSession();

  async function handleSubmit() {
    // collectionId and newCollectionName are mutually exclusive: if an existing
    // collection is selected, don't also send newCollectionName.
    const hasExistingCollection = !!form.collectionId && form.collectionId !== '__new__';
    const modelName = form.modelName.trim();
    const description = form.description.trim();
    const metadata = omitBlankMetadataValues(form.metadata);
    const batchMetadata: BatchUploadMetadata = {
      modelName,
      description: description || null,
      ...(hasExistingCollection ? { collectionId: form.collectionId } : {}),
      ...(!hasExistingCollection && form.newCollectionName.trim()
        ? { newCollectionName: form.newCollectionName.trim() }
        : {}),
      ...(form.artist.trim() ? { artist: form.artist.trim() } : {}),
      ...(form.tags.length > 0 ? { tags: form.tags } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
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
      <FormSection
        label={
          <span>
            Model details
            <SourceBadge source={sources.modelName} />
          </span>
        }
      >
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
            <SourceBadge source={sources.artist} />
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
      <FormSection
        label={
          <span>
            Tags to apply to all
            <SourceBadge source={sources.tags} />
          </span>
        }
      >
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
          {sources.tags === 'file'
            ? 'Read from the archive’s metadata.json. Press Enter or comma to add.'
            : 'Inferred from filenames + folder paths. Press Enter or comma to add.'}
        </p>
      </FormSection>

      {Object.keys(form.metadata).length > 0 && (
        <FormSection label="Additional metadata">
          <div className="flex flex-col gap-2">
            {Object.entries(form.metadata).map(([field, value]) => (
              <div key={field} className="grid grid-cols-[minmax(90px,0.35fr)_minmax(0,1fr)] items-center gap-2">
                <Label htmlFor={`draft-metadata-${field}`} className="truncate text-[12px] capitalize">
                  {metadataFieldNames.get(field) ?? field.replace(/[-_]+/g, ' ')}
                </Label>
                {form.metadataTypes[field] === 'boolean' ? (
                  <Checkbox
                    id={`draft-metadata-${field}`}
                    checked={value === true}
                    onChange={(event) => setForm((current) => ({
                      ...current,
                      metadata: { ...current.metadata, [field]: event.target.checked },
                    }))}
                    aria-label={field.replace(/[-_]+/g, ' ')}
                  />
                ) : (
                  <Input
                    id={`draft-metadata-${field}`}
                    type={form.metadataTypes[field] === 'number' ? 'number' : 'text'}
                    value={Array.isArray(value) ? value.join(', ') : value === null ? '' : String(value)}
                    onChange={(event) => setForm((current) => {
                      const type = current.metadataTypes[field];
                      const nextValue = type === 'array'
                        ? event.target.value.split(',').map((item) => item.trim()).filter(Boolean)
                        : type === 'number'
                          ? (event.target.value === '' ? null : Number(event.target.value))
                          : event.target.value;
                      return {
                        ...current,
                        metadata: { ...current.metadata, [field]: nextValue },
                      };
                    })}
                    className="text-[13px]"
                  />
                )}
              </div>
            ))}
          </div>
        </FormSection>
      )}

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
        Import one model
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
