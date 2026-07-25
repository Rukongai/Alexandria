import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CheckCircle2,
  Copy,
  EyeOff,
  FileSearch,
  Loader2,
  RefreshCw,
  Tags,
  Wrench,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import type { DuplicateFile, DuplicateModel, DuplicateScanResult } from '@alexandria/shared';
import {
  ignoreDuplicateFileGroup,
  markDuplicateFileGroup,
  markDuplicates,
  scanDuplicates,
} from '../api/tools';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { useLibraryPath } from '../hooks/use-libraries';
import { formatDate, formatFileSize } from '../lib/format';

interface FileGroupActionTarget {
  hash: string;
  setNumber: number;
}

export function ToolsPage() {
  const libPath = useLibraryPath();
  const queryClient = useQueryClient();
  const [actionFeedback, setActionFeedback] = useState('');
  const scan = useQuery({
    queryKey: ['tools', 'duplicate-scan'],
    queryFn: scanDuplicates,
    enabled: false,
    retry: false,
  });
  const refreshDuplicateData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['tools', 'duplicate-scan'], refetchType: 'none' }),
      queryClient.invalidateQueries({ queryKey: ['models'] }),
      queryClient.invalidateQueries({ queryKey: ['model'] }),
      queryClient.invalidateQueries({ queryKey: ['model-files'] }),
    ]);
    await scan.refetch();
  };
  const markMutation = useMutation({
    mutationFn: markDuplicates,
    onMutate: () => setActionFeedback(''),
    onSuccess: async (result) => {
      setActionFeedback(
        `Marked ${countPhrase(result.markedFileCount, 'duplicate file')} and ${countPhrase(result.markedModelCount, 'duplicate model')}.`,
      );
      await refreshDuplicateData();
    },
  });
  const markFileGroupMutation = useMutation({
    mutationFn: ({ hash }: FileGroupActionTarget) => markDuplicateFileGroup(hash),
    onMutate: () => setActionFeedback(''),
    onSuccess: async (result, target) => {
      setActionFeedback(
        `Marked duplicate file set ${target.setNumber}. ${countPhrase(result.markedFileCount, 'duplicate file')} and ${countPhrase(result.markedModelCount, 'duplicate model')} are now marked.`,
      );
      await refreshDuplicateData();
    },
  });
  const ignoreFileGroupMutation = useMutation({
    mutationFn: ({ hash }: FileGroupActionTarget) => ignoreDuplicateFileGroup(hash),
    onMutate: () => setActionFeedback(''),
    onSuccess: async (_result, target) => {
      setActionFeedback(
        `Ignored duplicate file set ${target.setNumber}. Any existing duplicate flags for this set were cleared.`,
      );
      await refreshDuplicateData();
    },
  });
  const actionPending =
    markMutation.isPending ||
    markFileGroupMutation.isPending ||
    ignoreFileGroupMutation.isPending;
  const actionError =
    markMutation.isError || markFileGroupMutation.isError || ignoreFileGroupMutation.isError;
  const actionErrorMessage = markMutation.isError
    ? 'Duplicates could not be marked.'
    : markFileGroupMutation.isError
      ? `Duplicate file set ${markFileGroupMutation.variables?.setNumber ?? ''} could not be marked.`
      : ignoreFileGroupMutation.isError
        ? `Duplicate file set ${ignoreFileGroupMutation.variables?.setNumber ?? ''} could not be ignored.`
        : '';
  const resetActions = () => {
    setActionFeedback('');
    markMutation.reset();
    markFileGroupMutation.reset();
    ignoreFileGroupMutation.reset();
  };
  let liveAnnouncement = '';
  if (markMutation.isPending) {
    liveAnnouncement = 'Marking all reported duplicate files and models.';
  } else if (markFileGroupMutation.isPending) {
    liveAnnouncement = `Marking duplicates in duplicate file set ${markFileGroupMutation.variables.setNumber}.`;
  } else if (ignoreFileGroupMutation.isPending) {
    liveAnnouncement = `Ignoring duplicate file set ${ignoreFileGroupMutation.variables.setNumber}.`;
  } else if (actionFeedback) {
    liveAnnouncement = actionFeedback;
  } else if (actionErrorMessage) {
    liveAnnouncement = actionErrorMessage;
  } else if (scan.isFetching) {
    liveAnnouncement = 'Scanning library for duplicate files and models.';
  } else if (scan.isError) {
    liveAnnouncement = 'The duplicate scan failed.';
  } else if (scan.data) {
    liveAnnouncement = duplicateScanAnnouncement(scan.data);
  }

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
          <Button
            onClick={() => {
              resetActions();
              void scan.refetch();
            }}
            disabled={scan.isFetching || actionPending}
          >
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
            {liveAnnouncement}
          </p>
          {actionFeedback && !actionPending && (
            <div className="mb-5 flex items-start gap-2 rounded-lg border border-emerald-600/30 bg-emerald-600/5 p-3 text-sm text-foreground">
              <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" />
              <p>{actionFeedback} The duplicate scan has been refreshed.</p>
            </div>
          )}
          {actionError && (
            <div role="alert" className="mb-5 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
              <p className="text-sm font-medium text-destructive">
                {actionErrorMessage}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                No changes were applied. Try the action again.
              </p>
            </div>
          )}
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
            <DuplicateResults
              result={scan.data}
              onMarkAll={() => {
                resetActions();
                markMutation.mutate();
              }}
              onMarkFileGroup={(target) => {
                resetActions();
                markFileGroupMutation.mutate(target);
              }}
              onIgnoreFileGroup={(target) => {
                resetActions();
                ignoreFileGroupMutation.mutate(target);
              }}
              markingAll={markMutation.isPending}
              activeFileGroupAction={
                markFileGroupMutation.isPending
                  ? { hash: markFileGroupMutation.variables.hash, action: 'mark' }
                  : ignoreFileGroupMutation.isPending
                    ? { hash: ignoreFileGroupMutation.variables.hash, action: 'ignore' }
                    : null
              }
              actionsDisabled={actionPending || scan.isFetching}
            />
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

function DuplicateResults({
  result,
  onMarkAll,
  onMarkFileGroup,
  onIgnoreFileGroup,
  markingAll,
  activeFileGroupAction,
  actionsDisabled,
}: {
  result: DuplicateScanResult;
  onMarkAll: () => void;
  onMarkFileGroup: (target: FileGroupActionTarget) => void;
  onIgnoreFileGroup: (target: FileGroupActionTarget) => void;
  markingAll: boolean;
  activeFileGroupAction: { hash: string; action: 'mark' | 'ignore' } | null;
  actionsDisabled: boolean;
}) {
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
      <section
        aria-labelledby="duplicate-actions-heading"
        className="flex flex-col gap-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 sm:flex-row sm:items-center sm:justify-between"
      >
        <div>
          <h2 id="duplicate-actions-heading" className="text-sm font-semibold text-foreground">
            Review these duplicate results
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Marking adds a Duplicate indicator to every reported file and to any model whose every
            file is duplicated. You can also mark or ignore one duplicate file set at a time below.
            Ignoring a set clears its existing Duplicate indicators. No review action deletes files.
          </p>
        </div>
        <div className="flex flex-shrink-0 flex-wrap gap-2">
          <Button onClick={onMarkAll} disabled={actionsDisabled}>
            {markingAll ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Tags className="mr-2 h-4 w-4" />
            )}
            {markingAll ? 'Marking…' : 'Mark all duplicates'}
          </Button>
        </div>
      </section>

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
              const setNumber = index + 1;
              const markingThisGroup =
                activeFileGroupAction?.hash === group.hash &&
                activeFileGroupAction.action === 'mark';
              const ignoringThisGroup =
                activeFileGroupAction?.hash === group.hash &&
                activeFileGroupAction.action === 'ignore';
              const oldestFileId = group.files.reduce((oldest, file) =>
                new Date(file.createdAt).getTime() < new Date(oldest.createdAt).getTime()
                  ? file
                  : oldest,
              ).id;

              return (
                <div key={group.hash} className="overflow-hidden rounded-lg border">
                  <div className="flex flex-col gap-3 border-b bg-muted/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h3 className="text-sm font-semibold text-foreground">
                        Duplicate file set {setNumber}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {group.files.length} identical files · {formatFileSize(group.sizeBytes)} each
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">
                        {formatFileSize(group.reclaimableBytes)} reclaimable
                      </Badge>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={
                          ignoringThisGroup
                            ? `Ignoring duplicates in file set ${setNumber}`
                            : `Ignore duplicates in file set ${setNumber}`
                        }
                        onClick={() => onIgnoreFileGroup({ hash: group.hash, setNumber })}
                        disabled={actionsDisabled}
                      >
                        {ignoringThisGroup ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <EyeOff className="mr-2 h-4 w-4" />
                        )}
                        {ignoringThisGroup ? 'Ignoring…' : 'Ignore duplicates'}
                      </Button>
                      <Button
                        size="sm"
                        aria-label={
                          markingThisGroup
                            ? `Marking duplicates in file set ${setNumber}`
                            : `Mark duplicates in file set ${setNumber}`
                        }
                        onClick={() => onMarkFileGroup({ hash: group.hash, setNumber })}
                        disabled={actionsDisabled}
                      >
                        {markingThisGroup ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Tags className="mr-2 h-4 w-4" />
                        )}
                        {markingThisGroup ? 'Marking…' : 'Mark duplicates'}
                      </Button>
                    </div>
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
              Ready models whose complete file sets match exactly. These matches are shown for
              reference and do not have separate review actions.
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
        Review file locations, model metadata, and collections before deleting a copy.
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
