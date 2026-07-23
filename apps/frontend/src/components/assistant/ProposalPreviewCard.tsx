import type { AiChange, AiChangePreview, AiChangePreviewDisplay } from '@alexandria/shared';
import { Check, FilePenLine, FolderInput, Image as ImageIcon, Tags, X } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';

interface ProposalPreviewCardProps {
  proposal: AiChangePreview;
  isApplying: boolean;
  isApplied: boolean;
  onApply: () => void;
  onDismiss: () => void;
}

function displayValue(value: unknown): string {
  if (value === null) return 'Clear value';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : 'Clear value';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function actionLines(change: AiChange, display?: AiChangePreviewDisplay): string[] {
  if (change.type === 'update_model') {
    return Object.entries(change.patch).map(([field, value]) => {
      if (field !== 'previewImageFileId') return `${field}: ${displayValue(value)}`;
      if (value === null) return 'Cover image: Use automatic cover';
      const image = typeof value === 'string' ? display?.images[value] : undefined;
      return `Cover image: ${image?.filename ?? displayValue(value)}`;
    });
  }

  if (change.type === 'set_metadata') {
    return Object.entries(change.values).map(
      ([field, value]) => `${field}: ${displayValue(value)}`,
    );
  }

  if (change.type === 'update_import_session') {
    return Object.entries(change.patch).flatMap(([field, value]) => {
      if (field === 'metadata' && value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.entries(value).map(
          ([metadataField, metadataValue]) => `${metadataField}: ${displayValue(metadataValue)}`,
        );
      }
      if (field === 'options' && value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.entries(value).map(
          ([option, optionValue]) => `${option}: ${displayValue(optionValue)}`,
        );
      }
      if (field === 'collectionId' && typeof value === 'string') {
        return [`Collection: ${display?.collections[value]?.name ?? value}`];
      }
      if (field === 'newCollectionName') return [`New collection: ${displayValue(value)}`];
      return [`${field}: ${displayValue(value)}`];
    });
  }

  return [
    ...change.addCollectionIds.map((id) => `Add to collection ${display?.collections[id]?.name ?? id}`),
    ...change.removeCollectionIds.map((id) => `Remove from collection ${display?.collections[id]?.name ?? id}`),
  ];
}

function thumbnailSrc(url: string): string {
  if (/^(?:https?:)?\/\//.test(url) || /^(?:data|blob):/.test(url)) return url;
  if (url.startsWith('/api/')) return url;
  return `/api${url.startsWith('/') ? '' : '/'}${url}`;
}

function CoverImagePreview({
  change,
  display,
}: {
  change: AiChange;
  display?: AiChangePreviewDisplay;
}) {
  if (change.type !== 'update_model' || !change.patch.previewImageFileId) return null;
  const image = display?.images[change.patch.previewImageFileId];
  if (!image) return null;

  return (
    <div className="mt-2 flex items-center gap-2 overflow-hidden rounded-lg border bg-background p-1.5">
      {image.thumbnailUrl ? (
        <img
          src={thumbnailSrc(image.thumbnailUrl)}
          alt={`Proposed cover: ${image.filename}`}
          className="h-12 w-12 shrink-0 rounded-md object-cover"
        />
      ) : (
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-md bg-muted">
          <ImageIcon className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        </span>
      )}
      <span className="min-w-0">
        <span className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Proposed cover</span>
        <span className="block truncate text-xs font-medium text-foreground">{image.filename}</span>
      </span>
    </div>
  );
}

function ChangeIcon({ change }: { change: AiChange }) {
  const className = 'mt-0.5 h-4 w-4 shrink-0 text-primary';
  if (change.type === 'update_model') return <FilePenLine className={className} />;
  if (change.type === 'set_metadata') return <Tags className={className} />;
  if (change.type === 'update_import_session') return <FilePenLine className={className} />;
  return <FolderInput className={className} />;
}

function changeLabel(change: AiChange): string {
  if (change.type === 'update_model') return `Update ${change.modelName}`;
  if (change.type === 'set_metadata') return `Set metadata on ${change.modelName}`;
  if (change.type === 'update_import_session') return `Update upload ${change.originalFilename}`;
  return `Update collections for ${change.modelName}`;
}

function changeKey(change: AiChange, index: number): string {
  const entityId = change.type === 'update_import_session'
    ? change.importSessionId
    : change.modelId;
  return `${entityId}-${change.type}-${index}`;
}

export function ProposalPreviewCard({
  proposal,
  isApplying,
  isApplied,
  onApply,
  onDismiss,
}: ProposalPreviewCardProps) {
  return (
    <section
      aria-label={`Preview: ${proposal.summary}`}
      className="mt-3 overflow-hidden rounded-xl border border-primary/25 bg-primary/[0.04]"
    >
      <div className="flex items-start justify-between gap-3 border-b border-primary/15 px-3 py-2.5">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2">
            <Badge variant="outline" className="border-primary/30 bg-background text-[10px] uppercase tracking-[0.14em] text-primary">
              Preview
            </Badge>
            {isApplied && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <Check className="h-3.5 w-3.5" /> Applied
              </span>
            )}
          </div>
          <p className="text-sm font-medium text-foreground">{proposal.summary}</p>
        </div>
      </div>

      <div className="space-y-3 px-3 py-3">
        {proposal.changes.map((change, index) => {
          const lines = actionLines(change, proposal.display);
          return (
            <div key={changeKey(change, index)} className="flex gap-2.5">
              <ChangeIcon change={change} />
              <div className="min-w-0">
                <p className="text-xs font-semibold text-foreground">{changeLabel(change)}</p>
                {lines.length > 0 ? (
                  <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                    {lines.map((line, lineIndex) => (
                      <li key={`${line}-${lineIndex}`} className="break-words">{line}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">No field-level actions.</p>
                )}
                <CoverImagePreview change={change} display={proposal.display} />
              </div>
            </div>
          );
        })}
      </div>

      {!isApplied && (
        <div className="flex items-center justify-end gap-2 border-t border-primary/15 bg-background/60 px-3 py-2.5">
          <Button type="button" variant="ghost" size="sm" onClick={onDismiss} disabled={isApplying}>
            <X className="mr-1.5 h-3.5 w-3.5" />
            Dismiss
          </Button>
          <Button type="button" size="sm" onClick={onApply} disabled={isApplying}>
            {isApplying ? 'Applying…' : 'Apply changes'}
          </Button>
        </div>
      )}
    </section>
  );
}
