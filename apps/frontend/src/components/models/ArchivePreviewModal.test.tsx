import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ArchivePreviewModal } from './ArchivePreviewModal';
import { downloadModelArchiveEntry, getModelArchiveContents } from '../../api/models';

vi.mock('../../api/models', () => ({
  downloadModelArchiveEntry: vi.fn(),
  getModelArchiveContents: vi.fn(),
}));

describe('ArchivePreviewModal', () => {
  it('lists archive entries and provides a download for individual files', async () => {
    vi.mocked(getModelArchiveContents).mockResolvedValue({
      entries: [
        { path: 'parts', sizeBytes: 0, isDirectory: true },
        { path: 'parts/body.stl', sizeBytes: 1024, isDirectory: false },
      ],
    });

    render(
      <ArchivePreviewModal
        modelId="model-1"
        open
        onOpenChange={vi.fn()}
        archive={{ fileId: 'archive-1', name: 'parts.7z' }}
      />,
    );

    expect(await screen.findByRole('list', { name: 'Archive contents' })).toBeVisible();
    expect(screen.getByText('parts')).toBeVisible();
    expect(screen.getByText('body.stl')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Download parts/body.stl' })).toBeVisible();
    expect(downloadModelArchiveEntry).not.toHaveBeenCalled();
    await waitFor(() => expect(getModelArchiveContents).toHaveBeenCalledWith(
      'model-1',
      'archive-1',
      expect.any(AbortSignal),
    ));
  });
});
