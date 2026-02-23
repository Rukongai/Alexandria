import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { FolderOpen, ArrowRight, AlertCircle, Loader2 } from 'lucide-react';
import { getFields } from '../../api/metadata';
import { importFolder } from '../../api/models';
import type { ImportStrategy } from '@alexandria/shared';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  PatternBuilder,
  createDefaultSegments,
  segmentsToPattern,
} from './PatternBuilder';
import type { MetadataFieldDetail } from '@alexandria/shared';

type Segment = Parameters<typeof PatternBuilder>[0]['segments'][number];

const STRATEGIES: { value: ImportStrategy; label: string; description: string }[] = [
  {
    value: 'hardlink',
    label: 'Hardlink',
    description:
      'Creates hardlinks to avoid copying data. Fastest. Requires same filesystem as the library.',
  },
  {
    value: 'copy',
    label: 'Copy',
    description:
      'Copies files into the library. Safe but uses more disk space. Originals are preserved.',
  },
  {
    value: 'move',
    label: 'Move',
    description:
      'Moves files into the library. Originals will be deleted after import.',
  },
];

type ImportState =
  | { phase: 'idle' }
  | { phase: 'submitting' }
  | { phase: 'submitted'; modelId: string }
  | { phase: 'error'; message: string };

export function FolderImport() {
  const [sourcePath, setSourcePath] = useState('');
  const [segments, setSegments] = useState<Segment[]>(createDefaultSegments);
  const [strategy, setStrategy] = useState<ImportStrategy>('hardlink');
  const [importState, setImportState] = useState<ImportState>({ phase: 'idle' });

  const { data: fields = [] } = useQuery<MetadataFieldDetail[]>({
    queryKey: ['metadata-fields'],
    queryFn: getFields,
    staleTime: 60_000,
  });

  const pattern = segmentsToPattern(segments);
  const isValidPattern =
    segments.length > 0 && segments[segments.length - 1].kind === 'model';
  const canSubmit =
    sourcePath.trim().length > 0 &&
    isValidPattern &&
    importState.phase !== 'submitting';

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setImportState({ phase: 'submitting' });
    try {
      const { modelId } = await importFolder({
        sourcePath: sourcePath.trim(),
        pattern,
        strategy,
      });
      setImportState({ phase: 'submitted', modelId });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Import failed. Please try again.';
      setImportState({ phase: 'error', message });
    }
  };

  const reset = () => {
    setSourcePath('');
    setSegments(createDefaultSegments());
    setStrategy('hardlink');
    setImportState({ phase: 'idle' });
  };

  return (
    <div className="space-y-6">
      {/* Source path */}
      <div className="space-y-1.5">
        <Label htmlFor="source-path">Source folder path (on server)</Label>
        <div className="relative">
          <FolderOpen className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            id="source-path"
            value={sourcePath}
            onChange={(e) => setSourcePath(e.target.value)}
            placeholder="/mnt/models/my-collection"
            className="pl-9 font-mono text-sm"
            disabled={importState.phase === 'submitting'}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Absolute path to the folder containing your models on the server filesystem.
        </p>
      </div>

      {/* Pattern builder */}
      <div className="space-y-2">
        <Label>Hierarchy pattern</Label>
        <p className="text-xs text-muted-foreground">
          Define how folder depth maps to collections and metadata. The last segment must be{' '}
          <code className="font-mono">model</code>.
        </p>
        <PatternBuilder
          segments={segments}
          metadataFields={fields}
          onChange={setSegments}
        />
      </div>

      {/* Strategy selection */}
      <div className="space-y-2">
        <Label>Import strategy</Label>
        <div className="space-y-2">
          {STRATEGIES.map((s) => (
            <label
              key={s.value}
              className={`flex items-start gap-3 rounded-lg border p-3.5 cursor-pointer transition-colors ${
                strategy === s.value
                  ? 'border-primary/60 bg-primary/5'
                  : 'border-border hover:border-primary/40 hover:bg-muted/40'
              }`}
            >
              <input
                type="radio"
                name="strategy"
                value={s.value}
                checked={strategy === s.value}
                onChange={() => setStrategy(s.value)}
                className="mt-0.5 accent-primary"
                disabled={importState.phase === 'submitting'}
              />
              <div>
                <p className="text-sm font-medium text-foreground">
                  {s.label}
                  {s.value === 'hardlink' && (
                    <span className="ml-2 text-xs font-normal text-primary">(recommended)</span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">{s.description}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Result / status */}
      {importState.phase === 'error' && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{importState.message}</span>
        </div>
      )}

      {importState.phase === 'submitted' && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-50 dark:bg-emerald-950/20 px-4 py-3 space-y-2">
          <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
            Import job queued successfully.
          </p>
          <div className="flex gap-3">
            <Link
              to={`/models/${importState.modelId}`}
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
              Track progress <ArrowRight className="h-3.5 w-3.5" />
            </Link>
            <button
              onClick={reset}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Import another folder
            </button>
          </div>
        </div>
      )}

      {/* Action */}
      {importState.phase !== 'submitted' && (
        <div className="flex gap-2">
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {importState.phase === 'submitting' && (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            )}
            Start Import
          </Button>
          {(sourcePath || importState.phase === 'error') && (
            <Button variant="outline" onClick={reset} disabled={importState.phase === 'submitting'}>
              Reset
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
