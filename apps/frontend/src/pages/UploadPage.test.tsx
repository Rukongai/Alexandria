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
    scanMultipartUpload: vi.fn(),
    discardImportSession: vi.fn(),
    uploadImportSessionFiles: vi.fn(),
  };
});

vi.mock('../api/collections', () => ({
  getCollections: vi.fn().mockResolvedValue({ data: [], meta: null, errors: null }),
}));

import {
  discardImportSession,
  listImportSessions,
  scanMultipartUpload,
  uploadImportSessionFiles,
} from '../api/models';

const failedSession: ImportSession = {
  id: '11111111-1111-4111-8111-111111111111',
  originalFilename: 'failed-upload.zip',
  status: 'error',
  detected: null,
  modelId: null,
  commitProgress: null,
  error: 'Archive is corrupt',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const scanningSession: ImportSession = {
  ...failedSession,
  id: '22222222-2222-4222-8222-222222222222',
  originalFilename: 'scanning-upload.zip',
  status: 'scanning',
  error: null,
};

const readySession: ImportSession = {
  ...failedSession,
  id: '33333333-3333-4333-8333-333333333333',
  originalFilename: 'ready-upload.zip',
  status: 'ready_for_review',
  error: null,
  detected: {
    modelCount: 1,
    fileCount: 1,
    totalSizeBytes: 100,
    artist: null,
    tagsGuessed: [],
    folderStructure: [{ name: 'model.stl', type: 'file', fileType: 'stl' }],
  },
};

describe('UploadPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the dedicated multi-part archive tab without changing ordinary uploads', async () => {
    vi.mocked(listImportSessions).mockResolvedValue([]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <UploadPage />
      </QueryClientProvider>,
    );

    expect(screen.getByRole('tab', { name: 'Archive upload' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'Multi-part archive' }));

    expect(screen.getByRole('tab', { name: 'Multi-part archive' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: 'Create one model from several files' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Server folder import' })).toBeVisible();
  });

  it('supports roving keyboard focus and activation across upload tabs', () => {
    vi.mocked(listImportSessions).mockResolvedValue([]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <UploadPage />
      </QueryClientProvider>,
    );

    const archiveTab = screen.getByRole('tab', { name: 'Archive upload' });
    const multipartTab = screen.getByRole('tab', { name: 'Multi-part archive' });
    const folderTab = screen.getByRole('tab', { name: 'Server folder import' });

    expect(archiveTab).toHaveAttribute('tabindex', '0');
    expect(multipartTab).toHaveAttribute('tabindex', '-1');
    archiveTab.focus();

    fireEvent.keyDown(archiveTab, { key: 'ArrowRight' });
    expect(multipartTab).toHaveFocus();
    expect(multipartTab).toHaveAttribute('aria-selected', 'true');
    expect(multipartTab).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(multipartTab, { key: 'End' });
    expect(folderTab).toHaveFocus();
    expect(folderTab).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(folderTab, { key: 'ArrowRight' });
    expect(archiveTab).toHaveFocus();
    expect(archiveTab).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(archiveTab, { key: 'ArrowLeft' });
    expect(folderTab).toHaveFocus();
    expect(folderTab).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(folderTab, { key: 'Home' });
    expect(archiveTab).toHaveFocus();
    expect(archiveTab).toHaveAttribute('aria-selected', 'true');
  });

  it('selects the new review session after a successful multipart upload', async () => {
    const groupedSession: ImportSession = {
      ...readySession,
      id: '44444444-4444-4444-8444-444444444444',
      originalFilename: 'group-first.zip',
    };
    vi.mocked(listImportSessions)
      .mockResolvedValueOnce([])
      .mockResolvedValue([groupedSession]);
    vi.mocked(scanMultipartUpload).mockResolvedValue({ sessionId: groupedSession.id });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <UploadPage />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Multi-part archive' }));
    const files = [
      new File(['one'], 'one.zip'),
      new File(['two'], 'two.zip'),
    ];
    fireEvent.change(screen.getByLabelText('Select multipart archive files'), {
      target: { files },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload as one model' }));

    await waitFor(() => {
      expect(scanMultipartUpload).toHaveBeenCalledWith(files, 'combine', expect.any(Function));
      expect(screen.getByRole('tab', { name: 'Archive upload' }))
        .toHaveAttribute('aria-selected', 'true');
      expect(screen.getByTestId('upload-review-grid')).toBeVisible();
      expect(screen.getByText('group-first.zip')).toBeVisible();
    });
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
      expect(screen.getByText('No imports yet. Drop an archive to start.')).toBeTruthy();
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

  it('discards a non-failed upload directly from the queue', async () => {
    vi.mocked(listImportSessions)
      .mockResolvedValueOnce([scanningSession])
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

    await waitFor(() => expect(screen.getByText('scanning-upload.zip')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Discard scanning-upload.zip' }));

    await waitFor(() => {
      expect(discardImportSession).toHaveBeenCalledWith(scanningSession.id);
      expect(screen.queryByText('scanning-upload.zip')).toBeNull();
    });
  });

  it('adds loose files to a ready model from its queue action', async () => {
    const updatedSession: ImportSession = {
      ...readySession,
      detected: {
        ...readySession.detected!,
        fileCount: 2,
        totalSizeBytes: 150,
      },
    };
    vi.mocked(listImportSessions).mockResolvedValue([readySession]);
    vi.mocked(uploadImportSessionFiles).mockResolvedValue(updatedSession);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <UploadPage />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('ready-upload.zip')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Add files to ready-upload.zip' }));
    const looseFile = new File(['preview'], 'preview.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Choose loose files for queued model'), {
      target: { files: [looseFile] },
    });

    await waitFor(() => {
      expect(uploadImportSessionFiles).toHaveBeenCalledWith(
        readySession.id,
        [looseFile],
        expect.any(Function),
      );
      expect(screen.getByText('150 B · 2 files')).toBeTruthy();
    });
  });
});
