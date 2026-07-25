import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  CheckCircle2,
  Copy,
  FileSearch,
  Loader2,
  RefreshCw,
  Wrench,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import type { DuplicateFile, DuplicateModel, DuplicateScanResult } from '@alexandria/shared';
import { scanDuplicates } from '../api/tools';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { useLibraryPath } from '../hooks/use-libraries';
import { formatDate, formatFileSize } from '../lib/format';

export function ToolsPage() {
  const libPath = useLibraryPath();
  const scan = useQuery({
    queryKey: ['tools', 'duplicate-scan'],
    queryFn: scanDuplicates,
    enabled: false,
    retry: false,
  });

  return (
    <div className="flex max-w-5xl flex-col gap-8 p-6">
      <header className="flex flex-col gap-3">
        <Link
          to={libPath('/')}
          className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Library
        </Link>
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-primary/10 p-2 text-primary">
            <Wrench className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">Tools</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Inspect and maintain the models in this library.
            </p>
          </div>
        </div>
      </header>

      <section className="overflow-hidden rounded-xl border bg-card">
        <div className="flex flex-col gap-4 border-b p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-muted p-2 text-foreground">
              <FileSearch className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-semibold text-foreground">Duplicate scanner</h2>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                Find individual files with identical contents and ready models with identical
                file sets. File names and folder layout do not affect matching.
              </p>
            </div>
          </div>
          <Button onClick={() => void scan.refetch()} disabled={scan.isFetching}>
            {scan.isFetching ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : scan.data ? (
              <RefreshCw className="mr-2 h-4 w-4" />
            ) : (
              <FileSearch className="mr-2 h-4 w-4" />
            )}
            {scan.isFetching ? 'Scanning…' : scan.data ? 'Scan again' : 'Scan library'}
          </Button>
        </div>

        <div className="p-5">
          <p role="status" aria-live="polite" className="sr-only">
            {scan.isFetching
              ? 'Scanning library for duplicate files and models.'
              : scan.isError
                ? 'The duplicate scan failed.'
                : scan.data
                  ? duplicateScanAnnouncement(scan.data)
                  : ''}
          </p>
          {scan.isFetching && !scan.data ? (
            <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <div>
                <p className="text-sm font-medium text-foreground">Scanning library…</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Comparing individual file contents and complete model file sets.
                </p>
              </div>
            </div>
          ) : scan.isError ? (
            <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
              <p className="text-sm font-medium text-destructive">The duplicate scan failed.</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Try again. If the problem continues, check the server logs.
              </p>
            </div>
          ) : scan.data ? (
            <DuplicateResults result={scan.data} />
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
              <Copy className="h-8 w-8 text-muted-foreground/60" />
              <div>
                <p className="text-sm font-medium text-foreground">No scan has been run yet</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Run the scanner to compare every ready model that contains files.
                </p>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function duplicateScanAnnouncement(result: DuplicateScanResult): string {
  const fileGroups = countPhrase(result.fileGroups.length, 'duplicate file group');
  const redundantFiles = countPhrase(result.redundantFileCount, 'redundant file');
  const modelGroups = countPhrase(result.groups.length, 'duplicate model group');
  const redundantModels = countPhrase(result.redundantModelCount, 'redundant model');

  return `Scan complete. Found ${fileGroups} with ${redundantFiles}, and ${modelGroups} with ${redundantModels}.`;
}

function countPhrase(count: number, singular: string): string {
  return `${count.toLocaleString()} ${singular}${count === 1 ? '' : 's'}`;
}

function DuplicateResults({ result }: { result: DuplicateScanResult }) {
  const hasDuplicateFiles = result.fileGroups.length > 0;
  const hasDuplicateModels = result.groups.length > 0;

  if (!hasDuplicateFiles && !hasDuplicateModels) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
        <CheckCircle2 className="h-9 w-9 text-emerald-600" />
        <div>
          <p className="font-medium text-foreground">No duplicate files or models found</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Compared {result.scannedFileCount.toLocaleString()}{' '}
            {result.scannedFileCount === 1 ? 'file' : 'files'} across{' '}
            {result.scannedModelCount.toLocaleString()}{' '}
            {result.scannedModelCount === 1 ? 'ready model' : 'ready models'}.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="duplicate-files-heading" className="flex flex-col gap-4">
        <div>
          <h2 id="duplicate-files-heading" className="text-base font-semibold text-foreground">
            Duplicate files
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Exact file matches across the library, regardless of their names or locations.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <ScanStat label="Files scanned" value={result.scannedFileCount.toLocaleString()} />
          <ScanStat label="Duplicate file groups" value={result.fileGroups.length.toLocaleString()} />
          <ScanStat label="Redundant files" value={result.redundantFileCount.toLocaleString()} />
          <ScanStat label="File savings" value={formatFileSize(result.fileReclaimableBytes)} />
        </div>

        {hasDuplicateFiles ? (
          <div className="flex flex-col gap-4">
            {result.fileGroups.map((group, index) => {
              const oldestFileId = group.files.reduce((oldest, file) =>
                new Date(file.createdAt).getTime() < new Date(oldest.createdAt).getTime()
                  ? file
                  : oldest,
              ).id;

              return (
                <div key={group.hash} className="overflow-hidden rounded-lg border">
                  <div className="flex flex-col gap-1 border-b bg-muted/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h3 className="text-sm font-semibold text-foreground">
                        Duplicate file set {index + 1}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {group.files.length} identical files · {formatFileSize(group.sizeBytes)} each
                      </p>
                    </div>
                    <Badge variant="outline">
                      {formatFileSize(group.reclaimableBytes)} reclaimable
                    </Badge>
                  </div>
                  <div className="divide-y">
                    {group.files.map((file) => (
                      <DuplicateFileRow
                        key={file.id}
                        file={file}
                        suggestedKeep={file.id === oldestFileId}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="rounded-lg border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
            No individual duplicate files were found.
          </p>
        )}
      </section>

      {hasDuplicateModels && (
        <section
          aria-labelledby="duplicate-models-heading"
          className="flex flex-col gap-4 border-t pt-6"
        >
          <div>
            <h2 id="duplicate-models-heading" className="text-base font-semibold text-foreground">
              Whole-model duplicates
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Ready models whose complete file sets match exactly.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <ScanStat label="Models scanned" value={result.scannedModelCount.toLocaleString()} />
            <ScanStat label="Duplicate model groups" value={result.groups.length.toLocaleString()} />
            <ScanStat label="Redundant models" value={result.redundantModelCount.toLocaleString()} />
            <ScanStat label="Model savings" value={formatFileSize(result.reclaimableBytes)} />
          </div>

          <div className="flex flex-col gap-4">
            {result.groups.map((group, index) => (
              <div key={group.fingerprint} className="overflow-hidden rounded-lg border">
                <div className="flex flex-col gap-1 border-b bg-muted/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">
                      Duplicate model set {index + 1}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {group.fileCount} {group.fileCount === 1 ? 'file' : 'files'} per model ·{' '}
                      {formatFileSize(group.totalSizeBytes)} each
                    </p>
                  </div>
                  <Badge variant="outline">
                    {group.models.length} identical models ·{' '}
                    {formatFileSize(group.reclaimableBytes)} reclaimable
                  </Badge>
                </div>
                <div className="divide-y">
                  {group.models.map((model, modelIndex) => (
                    <DuplicateModelRow
                      key={model.id}
                      model={model}
                      suggestedKeep={modelIndex === 0}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="text-xs text-muted-foreground">
        Results are informational. Review file locations, model metadata, and collections before
        deleting a copy.
      </p>
    </div>
  );
}

function ScanStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold text-foreground">{value}</p>
    </div>
  );
}

function DuplicateFileRow({
  file,
  suggestedKeep,
}: {
  file: DuplicateFile;
  suggestedKeep: boolean;
}) {
  const libPath = useLibraryPath();

  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-foreground">{file.filename}</p>
          {suggestedKeep && (
            <Badge variant="secondary" title="Oldest file in this duplicate set">
              Suggested keep
            </Badge>
          )}
        </div>
        <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={file.relativePath}>
          {file.relativePath}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-start sm:items-end">
        <Link
          to={libPath(`/models/${file.modelId}`)}
          className="text-sm font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {file.modelName}
        </Link>
        <span className="whitespace-nowrap text-xs text-muted-foreground">
          Added {formatDate(file.createdAt)}
        </span>
      </div>
    </div>
  );
}

function DuplicateModelRow({ model, suggestedKeep }: { model: DuplicateModel; suggestedKeep: boolean }) {
  const libPath = useLibraryPath();

  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Link
            to={libPath(`/models/${model.id}`)}
            className="truncate text-sm font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {model.name}
          </Link>
          {suggestedKeep && <Badge variant="secondary">Oldest copy</Badge>}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {model.originalFilename ?? 'No original filename'}
        </p>
      </div>
      <span className="whitespace-nowrap text-xs text-muted-foreground">
        Added {formatDate(model.createdAt)}
      </span>
    </div>
  );
}
