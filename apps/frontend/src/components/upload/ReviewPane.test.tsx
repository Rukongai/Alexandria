import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ImportSession } from '@alexandria/shared';
import { ReviewPane } from './ReviewPane';

vi.mock('../../api/models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/models')>();
  return {
    ...actual,
    extractImportSessionArchive: vi.fn(),
    getModelStatus: vi.fn(),
  };
});

vi.mock('../../api/collections', () => ({
  getCollections: vi.fn().mockResolvedValue({ data: [], meta: null, errors: null }),
}));

import { extractImportSessionArchive, getModelStatus } from '../../api/models';

const session: ImportSession = {
  id: '11111111-1111-4111-8111-111111111111',
  originalFilename: 'model-pack.zip',
  status: 'ready_for_review',
  modelId: null,
  commitProgress: null,
  error: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  detected: {
    modelCount: 1,
    fileCount: 2,
    totalSizeBytes: 150,
    artist: null,
    tagsGuessed: [],
    folderStructure: [
      {
        name: 'extras',
        type: 'folder',
        children: [{ name: 'parts.zip', type: 'file', fileType: 'other' }],
      },
    ],
    archives: [
      { filename: 'parts.zip', relativePath: 'extras/parts.zip', sizeBytes: 100 },
    ],
  },
};

describe('ReviewPane nested archives', () => {
  it('keeps preview content from widening the review columns', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const sessionWithPreviews: ImportSession = {
      ...session,
      detected: {
        ...session.detected!,
        previewImages: [
          {
            filename: 'very-wide-preview.png',
            relativePath: 'previews/very-wide-preview.png',
            sizeBytes: 50,
            mimeType: 'image/png',
          },
        ],
      },
    };

    render(
      <QueryClientProvider client={client}>
        <ReviewPane
          session={sessionWithPreviews}
          onCommitted={() => {}}
          onDiscard={() => {}}
          onRetry={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId('upload-review-grid')).toHaveStyle({
      gridTemplateColumns: 'minmax(0, 1.4fr) minmax(320px, 1fr)',
    });
    expect(screen.getByRole('img', { name: 'very-wide-preview.png' }).parentElement)
      .toHaveClass('min-w-0', 'overflow-hidden');
  });

  it('extracts a nested archive from the staged upload', async () => {
    vi.mocked(extractImportSessionArchive).mockResolvedValue(session);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <ReviewPane
          session={session}
          onCommitted={() => {}}
          onDiscard={() => {}}
          onRetry={() => {}}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Extract parts.zip' }));

    await waitFor(() => {
      expect(extractImportSessionArchive).toHaveBeenCalledWith(
        session.id,
        'extras/parts.zip',
      );
    });
  });

  it('shows managed-storage progress while a reviewed import is committing', async () => {
    vi.mocked(getModelStatus).mockResolvedValue({
      modelId: '22222222-2222-4222-8222-222222222222',
      status: 'processing',
      progress: null,
      error: null,
      startedAt: '',
      completedAt: null,
    });
    const committingSession: ImportSession = {
      ...session,
      status: 'committing',
      modelId: '22222222-2222-4222-8222-222222222222',
      commitProgress: {
        phase: 'storing_files',
        percent: 60,
        completedFiles: 2,
        totalFiles: 4,
        completedBytes: 3072,
        totalBytes: 4096,
        currentFilename: 'parts/dragon-tail.stl',
      },
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <ReviewPane
          session={committingSession}
          onCommitted={() => {}}
          onDiscard={() => {}}
          onRetry={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Saving model to library…' })).toBeVisible();
    const progressbar = await screen.findByRole('progressbar', { name: 'Import progress' });
    expect(progressbar).toHaveAttribute('aria-valuenow', '60');
    expect(screen.getByText('parts/dragon-tail.stl')).toBeVisible();
  });
});
