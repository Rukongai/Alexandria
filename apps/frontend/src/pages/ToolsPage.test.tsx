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

  it('shows matching models returned by the scanner', async () => {
    mockScanDuplicates.mockResolvedValue({
      scannedModelCount: 3,
      redundantModelCount: 1,
      reclaimableBytes: 2048,
      groups: [
        {
          fingerprint: 'same-files',
          fileCount: 2,
          totalSizeBytes: 2048,
          reclaimableBytes: 2048,
          models: [
            { id: 'model-1', name: 'Dragon original', originalFilename: 'dragon.zip', createdAt: '2025-01-01T00:00:00.000Z' },
            { id: 'model-2', name: 'Dragon copy', originalFilename: 'copy.zip', createdAt: '2025-02-01T00:00:00.000Z' },
          ],
        },
      ],
    });

    render(<ToolsPage />, { wrapper: makeWrapper() });
    fireEvent.click(screen.getByRole('button', { name: /scan library/i }));

    await waitFor(() => expect(screen.getByText('Dragon original')).toBeTruthy());
    expect(screen.getByText('Dragon copy')).toBeTruthy();
    expect(screen.getByText('Oldest copy')).toBeTruthy();
    expect(screen.getAllByText(/2\.0 KB/).length).toBeGreaterThan(0);
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
      redundantModelCount: 0,
      reclaimableBytes: 0,
      groups: [],
    });

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(/scan complete/i);
    });
  });

  it('shows a clear result when no duplicates are found', async () => {
    mockScanDuplicates.mockResolvedValue({
      scannedModelCount: 4,
      redundantModelCount: 0,
      reclaimableBytes: 0,
      groups: [],
    });

    render(<ToolsPage />, { wrapper: makeWrapper() });
    fireEvent.click(screen.getByRole('button', { name: /scan library/i }));

    await waitFor(() => expect(screen.getByText(/no duplicate models found/i)).toBeTruthy());
    expect(screen.getByText(/compared 4 ready models with files/i)).toBeTruthy();
  });
});
