import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ImportCommitPhase, ImportCommitProgress } from '@alexandria/shared';
import { UploadProgress, commitPhaseLabel } from './UploadProgress';

vi.mock('../../api/models', () => ({
  getModelStatus: vi.fn(),
}));

import { getModelStatus } from '../../api/models';

function renderProgress(commitProgress: ImportCommitProgress | null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <UploadProgress modelId="model-1" commitProgress={commitProgress} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('UploadProgress', () => {
  beforeEach(() => {
    vi.mocked(getModelStatus).mockResolvedValue({
      modelId: 'model-1',
      status: 'processing',
      progress: null,
      error: null,
      startedAt: '',
      completedAt: null,
    });
  });

  it.each<[ImportCommitPhase, string]>([
    ['queued', 'Saving files to library storage'],
    ['storing_files', 'Saving files to library storage'],
    ['saving_records', 'Recording files'],
    ['generating_thumbnails', 'Generating previews'],
    ['applying_metadata', 'Applying details'],
    ['complete', 'Finishing'],
  ])('should describe the %s phase as %s', (phase, label) => {
    expect(commitPhaseLabel(phase)).toBe(label);
  });

  it('should show exact byte, file, and filename progress while storing files', async () => {
    renderProgress({
      phase: 'storing_files',
      percent: 25,
      completedFiles: 2,
      totalFiles: 8,
      completedBytes: 2048,
      totalBytes: 8192,
      currentFilename: 'models/dragon-head.stl',
    });

    const progressbar = await screen.findByRole('progressbar', { name: 'Import progress' });
    expect(progressbar).toHaveAttribute('aria-valuenow', '25');
    expect(progressbar).toHaveAttribute(
      'aria-valuetext',
      'Saving files to library storage. 25%. 2.0 KB of 8.0 KB. 2 of 8 files. Current file: models/dragon-head.stl',
    );
    expect(screen.getByText('2.0 KB of 8.0 KB')).toBeVisible();
    expect(screen.getByText('2 of 8 files')).toBeVisible();
    expect(screen.getByText('models/dragon-head.stl')).toBeVisible();
  });

  it('should remain indeterminate without server commit progress', async () => {
    renderProgress(null);

    const progressbar = await screen.findByRole('progressbar', { name: 'Import progress' });
    expect(progressbar).not.toHaveAttribute('aria-valuenow');
    expect(progressbar).toHaveAttribute('aria-valuetext', 'Saving to library storage');
    expect(screen.getByText('Saving to library storage…')).toBeVisible();
    expect(screen.queryByText(/Extracting|Classifying/)).toBeNull();
  });

  it('should finish the commit phases before showing an early ready model as complete', async () => {
    vi.mocked(getModelStatus).mockResolvedValue({
      modelId: 'model-1',
      status: 'ready',
      progress: null,
      error: null,
      startedAt: '',
      completedAt: '',
    });
    renderProgress({
      phase: 'applying_metadata',
      percent: 95,
      completedFiles: 8,
      totalFiles: 8,
      completedBytes: 8192,
      totalBytes: 8192,
      currentFilename: null,
    });

    expect(await screen.findByText('Applying details…')).toBeVisible();
    expect(screen.queryByText('Model is ready.')).toBeNull();
  });

  it('should show the ready state when both model processing and commit progress are complete', async () => {
    vi.mocked(getModelStatus).mockResolvedValue({
      modelId: 'model-1',
      status: 'ready',
      progress: null,
      error: null,
      startedAt: '',
      completedAt: '',
    });
    renderProgress({
      phase: 'complete',
      percent: 100,
      completedFiles: 8,
      totalFiles: 8,
      completedBytes: 8192,
      totalBytes: 8192,
      currentFilename: null,
    });

    expect(await screen.findByText('Model is ready.')).toBeVisible();
    expect(screen.getByRole('link', { name: /view model/i })).toHaveAttribute(
      'href',
      '/models/model-1',
    );
    expect(screen.queryByRole('progressbar', { name: 'Import progress' })).toBeNull();
  });
});
