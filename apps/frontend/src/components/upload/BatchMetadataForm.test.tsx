import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CollectionDetail, DetectedImportMetadata } from '@alexandria/shared';
import { BatchMetadataForm } from './BatchMetadataForm';

vi.mock('../../api/collections', () => ({
  getCollections: vi.fn(),
}));

vi.mock('../../api/metadata', () => ({
  getFieldValues: vi.fn(),
}));

import { getCollections } from '../../api/collections';
import { getFieldValues } from '../../api/metadata';

const collection: CollectionDetail = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Figures',
  slug: 'figures',
  description: null,
  parentCollectionId: null,
  children: [],
  modelCount: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('BatchMetadataForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getFieldValues).mockResolvedValue([]);
  });

  it('lists collections when the browse rail has already populated its cache', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(['collections'], [collection]);
    vi.mocked(getCollections).mockResolvedValue({
      data: [collection],
      meta: null,
      errors: null,
    });

    render(
      <QueryClientProvider client={client}>
        <BatchMetadataForm
          sessionId="session-1"
          originalFilename="starter.zip"
          detected={{
            modelCount: 1,
            fileCount: 1,
            totalSizeBytes: 100,
            artist: null,
            tagsGuessed: [],
            folderStructure: [],
          }}
          onCommitted={vi.fn()}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Figures' })).toBeTruthy();
    });
    expect(getCollections).toHaveBeenCalledWith({ depth: 1 });
    expect(client.getQueryData(['collections'])).toEqual([collection]);
    expect(client.getQueryData(['collections', { depth: 1 }])).toEqual([collection]);
  });

  it('resets detected model metadata when the selected session changes', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.mocked(getCollections).mockResolvedValue({
      data: [],
      meta: null,
      errors: null,
    });

    const firstDetected: DetectedImportMetadata = {
      modelCount: 1,
      fileCount: 1,
      totalSizeBytes: 100,
      artist: 'First Artist',
      tagsGuessed: ['dragon'],
      folderStructure: [],
    };
    const secondDetected: DetectedImportMetadata = {
      modelCount: 1,
      fileCount: 1,
      totalSizeBytes: 100,
      artist: 'Second Artist',
      tagsGuessed: ['terrain'],
      folderStructure: [],
    };

    const { rerender } = render(
      <QueryClientProvider client={client}>
        <BatchMetadataForm
          sessionId="session-1"
          originalFilename="first-model.zip"
          detected={firstDetected}
          onCommitted={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByPlaceholderText('Artist name (optional)')).toHaveValue('First Artist');
    expect(screen.getByPlaceholderText('Model name')).toHaveValue('first-model');

    rerender(
      <QueryClientProvider client={client}>
        <BatchMetadataForm
          sessionId="session-2"
          originalFilename="second-model.zip"
          detected={secondDetected}
          onCommitted={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByPlaceholderText('Artist name (optional)')).toHaveValue('Second Artist');
    expect(screen.getByPlaceholderText('Model name')).toHaveValue('second-model');
  });

  it('should add an existing tag suggestion when it is selected', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(getCollections).mockResolvedValue({ data: [], meta: null, errors: null });
    vi.mocked(getFieldValues).mockResolvedValue([
      { value: 'Terrain', modelCount: 12 },
      { value: 'Fantasy', modelCount: 7 },
    ]);

    render(
      <QueryClientProvider client={client}>
        <BatchMetadataForm
          sessionId="session-1"
          originalFilename="starter.zip"
          detected={{
            modelCount: 1,
            fileCount: 1,
            totalSizeBytes: 100,
            artist: null,
            tagsGuessed: ['fantasy'],
            folderStructure: [],
          }}
          onCommitted={vi.fn()}
        />
      </QueryClientProvider>,
    );

    const input = screen.getByRole('combobox', { name: 'Tag name' });
    fireEvent.change(input, { target: { value: 'TERR' } });
    fireEvent.focus(input);
    fireEvent.click(await screen.findByRole('option', { name: /Terrain/ }));

    expect(screen.getByRole('button', { name: 'Remove tag Terrain' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Fantasy/ })).not.toBeInTheDocument();
    expect(getFieldValues).toHaveBeenCalledWith('tags');
  });

  it('should de-duplicate detected tags case-insensitively', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(getCollections).mockResolvedValue({ data: [], meta: null, errors: null });

    render(
      <QueryClientProvider client={client}>
        <BatchMetadataForm
          sessionId="session-1"
          originalFilename="starter.zip"
          detected={{
            modelCount: 1,
            fileCount: 1,
            totalSizeBytes: 100,
            artist: null,
            tagsGuessed: ['Fantasy', ' fantasy ', 'Terrain', '  '],
            folderStructure: [],
          }}
          onCommitted={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(screen.getAllByRole('button', { name: /Remove tag Fantasy/i })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Remove tag Terrain' })).toBeInTheDocument();
  });
});
