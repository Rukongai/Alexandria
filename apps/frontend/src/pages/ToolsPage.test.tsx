import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  consolidateDuplicateModels,
  ignoreDuplicateFileGroup,
  markDuplicateFileGroup,
  markDuplicates,
  previewDuplicateModelConsolidation,
  scanDuplicates,
} from '../api/tools';
import { ToolsPage } from './ToolsPage';

vi.mock('../api/tools', () => ({
  scanDuplicates: vi.fn(),
  markDuplicates: vi.fn(),
  markDuplicateFileGroup: vi.fn(),
  ignoreDuplicateFileGroup: vi.fn(),
  previewDuplicateModelConsolidation: vi.fn(),
  consolidateDuplicateModels: vi.fn(),
}));

const mockScanDuplicates = vi.mocked(scanDuplicates);
const mockMarkDuplicates = vi.mocked(markDuplicates);
const mockMarkDuplicateFileGroup = vi.mocked(markDuplicateFileGroup);
const mockIgnoreDuplicateFileGroup = vi.mocked(ignoreDuplicateFileGroup);
const mockPreviewDuplicateModelConsolidation = vi.mocked(previewDuplicateModelConsolidation);
const mockConsolidateDuplicateModels = vi.mocked(consolidateDuplicateModels);

const duplicateScanResult = {
  scannedModelCount: 2,
  scannedFileCount: 2,
  scannedArchiveFileCount: 0,
  scannedArchiveEntryCount: 0,
  redundantFileCount: 1,
  fileReclaimableBytes: 100,
  fileGroups: [
    {
      hash: 'same-file',
      sizeBytes: 100,
      reclaimableBytes: 100,
      files: [
        {
          id: 'file-1',
          modelId: 'model-1',
          modelName: 'First model',
          filename: 'part.stl',
          relativePath: 'part.stl',
          sizeBytes: 100,
          createdAt: '2025-01-01T00:00:00.000Z',
        },
        {
          id: 'file-2',
          modelId: 'model-2',
          modelName: 'Second model',
          filename: 'part-copy.stl',
          relativePath: 'part-copy.stl',
          sizeBytes: 100,
          createdAt: '2025-02-01T00:00:00.000Z',
        },
      ],
    },
  ],
  archiveFileGroups: [],
  redundantModelCount: 0,
  reclaimableBytes: 0,
  groups: [],
};

const emptyScanResult = {
  scannedModelCount: 2,
  scannedFileCount: 2,
  scannedArchiveFileCount: 0,
  scannedArchiveEntryCount: 0,
  redundantFileCount: 0,
  fileReclaimableBytes: 0,
  fileGroups: [],
  archiveFileGroups: [],
  redundantModelCount: 0,
  reclaimableBytes: 0,
  groups: [],
};

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/tools']}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('ToolsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMarkDuplicates.mockResolvedValue({ markedFileCount: 0, markedModelCount: 0 });
    mockMarkDuplicateFileGroup.mockResolvedValue({ markedFileCount: 0, markedModelCount: 0 });
    mockIgnoreDuplicateFileGroup.mockResolvedValue({
      ignoredFileGroupCount: 0,
      ignoredModelGroupCount: 0,
    });
    mockPreviewDuplicateModelConsolidation.mockResolvedValue({
      sourceModel: { id: 'model-2', name: 'Dragon copy' },
      targetModel: { id: 'model-1', name: 'Dragon original' },
      removedFiles: [{
        id: 'file-2',
        filename: 'body-copy.stl',
        relativePath: 'parts/body-copy.stl',
        sizeBytes: 1024,
        hash: 'a'.repeat(64),
      }],
      removedThumbnails: [],
      copiedMetadata: [],
      addedCollections: [],
      addedTags: [],
      copiedMetadataFieldCount: 1,
      addedCollectionCount: 1,
      addedTagCount: 2,
      deletedFileCount: 1,
      reclaimableBytes: 1024,
      deletedSourceModelId: 'model-2',
    });
    mockConsolidateDuplicateModels.mockResolvedValue({
      sourceModel: { id: 'model-2', name: 'Dragon copy' },
      targetModel: { id: 'model-1', name: 'Dragon original' },
      removedFiles: [],
      removedThumbnails: [],
      copiedMetadata: [],
      addedCollections: [],
      addedTags: [],
      copiedMetadataFieldCount: 1,
      addedCollectionCount: 1,
      addedTagCount: 2,
      deletedFileCount: 1,
      reclaimableBytes: 1024,
      deletedSourceModelId: 'model-2',
    });
  });

  it('waits for the user to start a duplicate scan', () => {
    render(<ToolsPage />, { wrapper: makeWrapper() });

    expect(screen.getByRole('heading', { name: 'Tools' })).toBeTruthy();
    expect(screen.getByText(/no scan has been run yet/i)).toBeTruthy();
    expect(mockScanDuplicates).not.toHaveBeenCalled();
  });

  it('leads with matching files and shows whole-model duplicates secondarily', async () => {
    mockScanDuplicates.mockResolvedValue({
      scannedModelCount: 3,
      scannedFileCount: 8,
      scannedArchiveFileCount: 2,
      scannedArchiveEntryCount: 5,
      redundantFileCount: 1,
      fileReclaimableBytes: 1024,
      fileGroups: [
        {
          hash: 'matching-file',
          sizeBytes: 1024,
          reclaimableBytes: 1024,
          files: [
            {
              id: 'file-2',
              modelId: 'model-2',
              modelName: 'Dragon copy',
              filename: 'body-copy.stl',
              relativePath: 'parts/body-copy.stl',
              sizeBytes: 1024,
              createdAt: '2025-02-01T00:00:00.000Z',
            },
            {
              id: 'file-1',
              modelId: 'model-1',
              modelName: 'Dragon original',
              filename: 'body.stl',
              relativePath: 'meshes/body.stl',
              sizeBytes: 1024,
              createdAt: '2025-01-01T00:00:00.000Z',
            },
          ],
        },
      ],
      redundantModelCount: 1,
      reclaimableBytes: 2048,
      groups: [
        {
          fingerprint: 'same-files',
          fileCount: 2,
          totalSizeBytes: 2048,
          reclaimableBytes: 2048,
          models: [
            {
              id: 'model-1',
              name: 'Dragon original',
              originalFilename: 'dragon.zip',
              createdAt: '2025-01-01T00:00:00.000Z',
            },
            {
              id: 'model-2',
              name: 'Dragon copy',
              originalFilename: 'copy.zip',
              createdAt: '2025-02-01T00:00:00.000Z',
            },
          ],
        },
      ],
      archiveFileGroups: [
        {
          hash: 'matching-archive-member',
          sizeBytes: 512,
          reclaimableBytes: 512,
          files: [
            {
              id: 'archive-entry-1',
              modelId: 'model-1',
              modelName: 'Dragon original',
              filename: 'body.stl',
              relativePath: 'meshes/body.stl',
              archiveFileId: 'archive-file-1',
              archiveFilename: 'dragon.zip',
              archiveRelativePath: 'archives/dragon.zip',
              sizeBytes: 512,
              createdAt: '2025-01-01T00:00:00.000Z',
            },
            {
              id: 'archive-entry-2',
              modelId: 'model-2',
              modelName: 'Dragon copy',
              filename: 'body.stl',
              relativePath: 'meshes/body.stl',
              archiveFileId: 'archive-file-2',
              archiveFilename: 'dragon-copy.zip',
              archiveRelativePath: 'archives/dragon-copy.zip',
              sizeBytes: 512,
              createdAt: '2025-02-01T00:00:00.000Z',
            },
          ],
        },
      ],
    });

    render(<ToolsPage />, { wrapper: makeWrapper() });
    fireEvent.click(screen.getByRole('button', { name: /scan library/i }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Duplicate files' })).toBeTruthy());
    expect(screen.getByText('body-copy.stl')).toBeTruthy();
    expect(screen.getAllByText('meshes/body.stl')).toHaveLength(3);
    expect(
      screen.getAllByRole('link', { name: 'Dragon original' })[0].getAttribute('href'),
    ).toBe('/models/model-1');
    expect(screen.getByText('Suggested keep').parentElement?.textContent).toContain('body.stl');
    expect(screen.getByRole('heading', { name: 'Whole-model duplicates' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Duplicate archive members' })).toBeTruthy();
    expect(screen.getByText('archives/dragon.zip')).toBeTruthy();
    expect(screen.getByText('archives/dragon-copy.zip')).toBeTruthy();
    expect(screen.getByText('Informational only')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /mark duplicates in archive/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /ignore duplicates in archive/i })).toBeNull();
    expect(screen.getByText('Archive files scanned').nextElementSibling?.textContent).toBe('2');
    expect(screen.getByText('Archive entries scanned').nextElementSibling?.textContent).toBe('5');
    expect(screen.getByText('Oldest copy')).toBeTruthy();
    expect(screen.getByText('Files scanned').nextElementSibling?.textContent).toBe('8');
    expect(screen.getByRole('button', { name: /mark duplicates in file set 1/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /ignore duplicates in file set 1/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^ignore duplicates$/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Consolidate' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /consolidate all/i })).toBeNull();

    const fileHeading = screen.getByRole('heading', { name: 'Duplicate files' });
    const modelHeading = screen.getByRole('heading', { name: 'Whole-model duplicates' });
    expect(
      fileHeading.compareDocumentPosition(modelHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('previews every file action and requires confirmation before consolidating one model', async () => {
    mockScanDuplicates.mockResolvedValue({
      ...duplicateScanResult,
      groups: [{
        fingerprint: 'same-files',
        fileCount: 1,
        totalSizeBytes: 100,
        reclaimableBytes: 100,
        models: [
          { id: 'model-1', name: 'First model', originalFilename: 'first.zip', createdAt: '2025-01-01T00:00:00.000Z' },
          { id: 'model-2', name: 'Second model', originalFilename: 'second.zip', createdAt: '2025-02-01T00:00:00.000Z' },
        ],
      }],
    });

    render(<ToolsPage />, { wrapper: makeWrapper() });
    fireEvent.click(screen.getByRole('button', { name: /scan library/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Consolidate' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Consolidate' }));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(mockConsolidateDuplicateModels).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));

    await waitFor(() => {
      expect(mockPreviewDuplicateModelConsolidation).toHaveBeenCalledWith('model-2', 'model-1');
    });
    expect(screen.getByText('Files to remove')).toBeTruthy();
    expect(screen.getByText('parts/body-copy.stl')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /consolidate and remove duplicate/i }));
    await waitFor(() => {
      expect(mockConsolidateDuplicateModels).toHaveBeenCalledWith('model-2', 'model-1');
    });
  });

  it('announces scan progress and completion', async () => {
    let finishScan!: (value: Awaited<ReturnType<typeof scanDuplicates>>) => void;
    mockScanDuplicates.mockReturnValue(new Promise((resolve) => { finishScan = resolve; }));

    render(<ToolsPage />, { wrapper: makeWrapper() });
    fireEvent.click(screen.getByRole('button', { name: /scan library/i }));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(/scanning library/i);
    });
    expect(screen.getByText('Scanning library…')).toBeTruthy();

    finishScan({
      scannedModelCount: 2,
      scannedFileCount: 5,
      scannedArchiveFileCount: 0,
      scannedArchiveEntryCount: 0,
      redundantFileCount: 1,
      fileReclaimableBytes: 100,
      fileGroups: [
        {
          hash: 'same-file',
          sizeBytes: 100,
          reclaimableBytes: 100,
          files: [
            {
              id: 'file-1',
              modelId: 'model-1',
              modelName: 'First model',
              filename: 'part.stl',
              relativePath: 'part.stl',
              sizeBytes: 100,
              createdAt: '2025-01-01T00:00:00.000Z',
            },
            {
              id: 'file-2',
              modelId: 'model-2',
              modelName: 'Second model',
              filename: 'part-copy.stl',
              relativePath: 'copies/part-copy.stl',
              sizeBytes: 100,
              createdAt: '2025-02-01T00:00:00.000Z',
            },
          ],
        },
      ],
      redundantModelCount: 0,
      reclaimableBytes: 0,
      groups: [],
      archiveFileGroups: [],
    });

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(
        /found 1 duplicate file group with 1 redundant file/i,
      );
    });
  });

  it('shows a clear result only when no duplicate files or models are found', async () => {
    mockScanDuplicates.mockResolvedValue({
      scannedModelCount: 4,
      scannedFileCount: 12,
      scannedArchiveFileCount: 0,
      scannedArchiveEntryCount: 0,
      redundantFileCount: 0,
      fileReclaimableBytes: 0,
      fileGroups: [],
      redundantModelCount: 0,
      reclaimableBytes: 0,
      groups: [],
      archiveFileGroups: [],
    });

    render(<ToolsPage />, { wrapper: makeWrapper() });
    fireEvent.click(screen.getByRole('button', { name: /scan library/i }));

    await waitFor(() => expect(screen.getByText(/no duplicate files, models, or archive members found/i)).toBeTruthy());
    expect(screen.getByText(/compared 12 files across 4 ready models/i)).toBeTruthy();
  });

  it('announces a failed rescan instead of the retained successful result', async () => {
    mockScanDuplicates
      .mockResolvedValueOnce({
        scannedModelCount: 1,
        scannedFileCount: 1,
        scannedArchiveFileCount: 0,
        scannedArchiveEntryCount: 0,
        redundantFileCount: 0,
        fileReclaimableBytes: 0,
        fileGroups: [],
        redundantModelCount: 0,
        reclaimableBytes: 0,
        groups: [],
        archiveFileGroups: [],
      })
      .mockRejectedValueOnce(new Error('scan failed'));

    render(<ToolsPage />, { wrapper: makeWrapper() });
    fireEvent.click(screen.getByRole('button', { name: /scan library/i }));
    await waitFor(() => expect(screen.getByText(/no duplicate files, models, or archive members found/i)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /scan again/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('status').textContent).toMatch(/duplicate scan failed/i);
    expect(screen.getByRole('status').textContent).not.toMatch(/scan complete/i);
  });

  it('marks every reported duplicate with pending state, feedback, and a refreshed scan', async () => {
    let finishMark!: (value: Awaited<ReturnType<typeof markDuplicates>>) => void;
    mockScanDuplicates.mockResolvedValue(duplicateScanResult);
    mockMarkDuplicates.mockReturnValue(new Promise((resolve) => { finishMark = resolve; }));

    render(<ToolsPage />, { wrapper: makeWrapper() });
    fireEvent.click(screen.getByRole('button', { name: /scan library/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /mark all duplicates/i })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /mark all duplicates/i }));

    await waitFor(() => expect(mockMarkDuplicates).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: /marking/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /ignore duplicates in file set 1/i })).toBeDisabled();
    expect(screen.getByRole('status').textContent).toMatch(/marking all reported duplicate/i);

    finishMark({ markedFileCount: 2, markedModelCount: 1 });

    await waitFor(() => {
      expect(
        screen.getAllByText(/marked 2 duplicate files and 1 duplicate model/i),
      ).toHaveLength(2);
    });
    expect(mockScanDuplicates).toHaveBeenCalledTimes(2);
  });

  it('marks one file set by hash and identifies the pending set', async () => {
    let finishMark!: (value: Awaited<ReturnType<typeof markDuplicateFileGroup>>) => void;
    mockScanDuplicates.mockResolvedValue(duplicateScanResult);
    mockMarkDuplicateFileGroup.mockReturnValue(new Promise((resolve) => { finishMark = resolve; }));

    render(<ToolsPage />, { wrapper: makeWrapper() });
    fireEvent.click(screen.getByRole('button', { name: /scan library/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /mark duplicates in file set 1/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /mark duplicates in file set 1/i }));

    await waitFor(() => expect(mockMarkDuplicateFileGroup).toHaveBeenCalledWith('same-file'));
    expect(screen.getByRole('button', { name: /marking duplicates in file set 1/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /mark all duplicates/i })).toBeDisabled();
    expect(screen.getByRole('status').textContent).toMatch(
      /marking duplicates in duplicate file set 1/i,
    );

    finishMark({ markedFileCount: 2, markedModelCount: 1 });

    await waitFor(() => {
      expect(screen.getAllByText(/marked duplicate file set 1. 2 duplicate files and 1 duplicate model are now marked/i)).toHaveLength(2);
    });
    expect(mockScanDuplicates).toHaveBeenCalledTimes(2);
  });

  it('ignores one file set by hash and shows the refreshed empty result', async () => {
    mockScanDuplicates
      .mockResolvedValueOnce(duplicateScanResult)
      .mockResolvedValueOnce(emptyScanResult);
    mockIgnoreDuplicateFileGroup.mockResolvedValue({
      ignoredFileGroupCount: 1,
      ignoredModelGroupCount: 0,
    });

    render(<ToolsPage />, { wrapper: makeWrapper() });
    fireEvent.click(screen.getByRole('button', { name: /scan library/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /ignore duplicates in file set 1/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /ignore duplicates in file set 1/i }));

    await waitFor(() => {
      expect(
        screen.getAllByText(
          /ignored duplicate file set 1. any existing duplicate flags for this set were cleared/i,
        ),
      ).toHaveLength(2);
    });
    expect(mockIgnoreDuplicateFileGroup).toHaveBeenCalledWith('same-file');
    expect(mockScanDuplicates).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/no duplicate files, models, or archive members found/i)).toBeTruthy();
  });

  it('announces an accessible error for the file set action that failed', async () => {
    mockScanDuplicates.mockResolvedValue(duplicateScanResult);
    mockIgnoreDuplicateFileGroup.mockRejectedValue(new Error('ignore failed'));

    render(<ToolsPage />, { wrapper: makeWrapper() });
    fireEvent.click(screen.getByRole('button', { name: /scan library/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /ignore duplicates in file set 1/i })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /ignore duplicates in file set 1/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(
        /duplicate file set 1 could not be ignored/i,
      );
    });
    expect(screen.getByRole('status').textContent).toMatch(
      /duplicate file set 1 could not be ignored/i,
    );
    expect(mockScanDuplicates).toHaveBeenCalledOnce();
  });
});
