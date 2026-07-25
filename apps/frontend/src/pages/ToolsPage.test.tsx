import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scanDuplicates } from '../api/tools';
import { ToolsPage } from './ToolsPage';

vi.mock('../api/tools', () => ({ scanDuplicates: vi.fn() }));

const mockScanDuplicates = vi.mocked(scanDuplicates);

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
  beforeEach(() => vi.clearAllMocks());

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
    });

    render(<ToolsPage />, { wrapper: makeWrapper() });
    fireEvent.click(screen.getByRole('button', { name: /scan library/i }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Duplicate files' })).toBeTruthy());
    expect(screen.getByText('body-copy.stl')).toBeTruthy();
    expect(screen.getByText('meshes/body.stl')).toBeTruthy();
    expect(
      screen.getAllByRole('link', { name: 'Dragon original' })[0].getAttribute('href'),
    ).toBe('/models/model-1');
    expect(screen.getByText('Suggested keep').parentElement?.textContent).toContain('body.stl');
    expect(screen.getByRole('heading', { name: 'Whole-model duplicates' })).toBeTruthy();
    expect(screen.getByText('Oldest copy')).toBeTruthy();
    expect(screen.getByText('Files scanned').nextElementSibling?.textContent).toBe('8');

    const fileHeading = screen.getByRole('heading', { name: 'Duplicate files' });
    const modelHeading = screen.getByRole('heading', { name: 'Whole-model duplicates' });
    expect(
      fileHeading.compareDocumentPosition(modelHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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
      redundantFileCount: 0,
      fileReclaimableBytes: 0,
      fileGroups: [],
      redundantModelCount: 0,
      reclaimableBytes: 0,
      groups: [],
    });

    render(<ToolsPage />, { wrapper: makeWrapper() });
    fireEvent.click(screen.getByRole('button', { name: /scan library/i }));

    await waitFor(() => expect(screen.getByText(/no duplicate files or models found/i)).toBeTruthy());
    expect(screen.getByText(/compared 12 files across 4 ready models/i)).toBeTruthy();
  });

  it('announces a failed rescan instead of the retained successful result', async () => {
    mockScanDuplicates
      .mockResolvedValueOnce({
        scannedModelCount: 1,
        scannedFileCount: 1,
        redundantFileCount: 0,
        fileReclaimableBytes: 0,
        fileGroups: [],
        redundantModelCount: 0,
        reclaimableBytes: 0,
        groups: [],
      })
      .mockRejectedValueOnce(new Error('scan failed'));

    render(<ToolsPage />, { wrapper: makeWrapper() });
    fireEvent.click(screen.getByRole('button', { name: /scan library/i }));
    await waitFor(() => expect(screen.getByText(/no duplicate files or models found/i)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /scan again/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('status').textContent).toMatch(/duplicate scan failed/i);
    expect(screen.getByRole('status').textContent).not.toMatch(/scan complete/i);
  });
});
