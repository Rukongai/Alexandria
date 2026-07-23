import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ImportSession } from '@alexandria/shared';
import { UploadQueue } from './UploadQueue';

const committingSession: ImportSession = {
  id: '11111111-1111-4111-8111-111111111111',
  originalFilename: 'dragon-pack.zip',
  status: 'committing',
  draftMetadata: null,
  detected: {
    modelCount: 1,
    fileCount: 4,
    totalSizeBytes: 4096,
    artist: null,
    tagsGuessed: [],
    folderStructure: [],
  },
  modelId: '22222222-2222-4222-8222-222222222222',
  commitProgress: {
    phase: 'storing_files',
    percent: 40,
    completedFiles: 1,
    totalFiles: 4,
    completedBytes: 1024,
    totalBytes: 4096,
    currentFilename: 'parts/dragon-body.stl',
  },
  error: null,
  createdAt: '2026-07-22T12:00:00.000Z',
  updatedAt: '2026-07-22T12:00:00.000Z',
};

const callbacks = {
  activeId: committingSession.id,
  onSelect: vi.fn(),
  onDiscard: vi.fn(),
  onAddFiles: vi.fn(),
  discardingId: null,
  addingFilesId: null,
};

describe('UploadQueue commit progress', () => {
  it('should show exact managed-storage progress for a committing import', () => {
    render(<UploadQueue sessions={[committingSession]} {...callbacks} />);

    expect(screen.getByText('Import queue')).toBeVisible();
    expect(screen.getByText('Saving files to library storage')).toBeVisible();
    expect(screen.getByText('1.0 KB / 4.0 KB')).toBeVisible();
    expect(screen.getByText('1 / 4 files')).toBeVisible();
    expect(screen.getByText('parts/dragon-body.stl')).toBeVisible();

    const progressbar = screen.getByRole('progressbar', {
      name: 'Saving dragon-pack.zip to library storage',
    });
    expect(progressbar).toHaveAttribute('aria-valuenow', '40');
    expect(progressbar).toHaveAttribute(
      'aria-valuetext',
      'Saving files to library storage. 40%. 1.0 KB of 4.0 KB. 1 of 4 files. Current file: parts/dragon-body.stl',
    );
    expect(progressbar.closest('button')).toBeNull();
  });

  it('should show an honest indeterminate label when commit progress is unavailable', () => {
    render(
      <UploadQueue
        sessions={[{ ...committingSession, commitProgress: null }]}
        {...callbacks}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Saving to library storage…');
    const progressbar = screen.getByRole('progressbar', {
      name: 'Saving dragon-pack.zip to library storage',
    });
    expect(progressbar).not.toHaveAttribute('aria-valuenow');
    expect(progressbar).toHaveAttribute('aria-valuetext', 'Saving to library storage');
  });
});
