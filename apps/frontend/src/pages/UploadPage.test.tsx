import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ImportSession } from '@alexandria/shared';
import { UploadPage } from './UploadPage';

vi.mock('../api/models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/models')>();
  return {
    ...actual,
    listImportSessions: vi.fn(),
    discardImportSession: vi.fn(),
  };
});

import { discardImportSession, listImportSessions } from '../api/models';

const failedSession: ImportSession = {
  id: '11111111-1111-4111-8111-111111111111',
  originalFilename: 'failed-upload.zip',
  status: 'error',
  detected: null,
  modelId: null,
  error: 'Archive is corrupt',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('UploadPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes a failed upload and removes it from the queue', async () => {
    vi.mocked(listImportSessions)
      .mockResolvedValueOnce([failedSession])
      .mockResolvedValue([]);
    vi.mocked(discardImportSession).mockResolvedValue(undefined);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <UploadPage />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('failed-upload.zip')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    await waitFor(() => {
      expect(discardImportSession).toHaveBeenCalledWith(failedSession.id);
      expect(screen.queryByText('failed-upload.zip')).toBeNull();
      expect(screen.getByText('No uploads yet. Drop an archive to start.')).toBeTruthy();
    });
  });

  it('restores the failed upload when deletion fails', async () => {
    vi.mocked(listImportSessions).mockResolvedValue([failedSession]);
    vi.mocked(discardImportSession).mockRejectedValue(new Error('Delete failed'));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <UploadPage />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('failed-upload.zip')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    await waitFor(() => {
      expect(discardImportSession).toHaveBeenCalledWith(failedSession.id);
      expect(screen.getByText('failed-upload.zip')).toBeTruthy();
    });
  });
});
