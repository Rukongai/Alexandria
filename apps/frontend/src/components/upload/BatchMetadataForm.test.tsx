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

vi.mock('../../api/models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/models')>();
  return { ...actual, commitImportSession: vi.fn() };
});

import { getCollections } from '../../api/collections';
import { getFieldValues } from '../../api/metadata';
import { commitImportSession } from '../../api/models';

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

function collectionSelect(): HTMLSelectElement {
  const select = screen.getByRole('option', { name: '— None —' }).closest('select');
  if (!select) throw new Error('collection select not found');
  return select as HTMLSelectElement;
}

describe('BatchMetadataForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getFieldValues).mockResolvedValue([]);
    vi.mocked(commitImportSession).mockResolvedValue({ modelId: 'model-1', jobId: 'job-1' });
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
    expect(screen.getByRole('button', { name: 'Import one model' })).toBeVisible();
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

  it('refreshes from a changed AI draft without letting polling clobber local edits', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(getCollections).mockResolvedValue({ data: [], meta: null, errors: null });
    const detected: DetectedImportMetadata = {
      modelCount: 1,
      fileCount: 1,
      totalSizeBytes: 100,
      artist: null,
      tagsGuessed: [],
      folderStructure: [],
    };
    const firstDraft = {
      modelName: 'Lust',
      artist: 'Model Artist',
      metadata: { source: 'Fullmetal Alchemist', year: 2024, mature: false },
    };

    const { rerender } = render(
      <QueryClientProvider client={client}>
        <BatchMetadataForm
          sessionId="session-1"
          originalFilename="Artist - 2024 - Lust.zip"
          detected={detected}
          draftMetadata={firstDraft}
          resetKey="draft-1"
          onCommitted={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByPlaceholderText('Model name')).toHaveValue('Lust');
    expect(screen.getByLabelText('source')).toHaveValue('Fullmetal Alchemist');
    fireEvent.change(screen.getByPlaceholderText('Model name'), { target: { value: 'My local edit' } });

    rerender(
      <QueryClientProvider client={client}>
        <BatchMetadataForm
          sessionId="session-1"
          originalFilename="Artist - 2024 - Lust.zip"
          detected={{
            ...detected,
            artist: 'New scanner guess',
            tagsGuessed: ['new-scanner-tag'],
          }}
          draftMetadata={{ ...firstDraft, metadata: { ...firstDraft.metadata } }}
          resetKey="draft-1"
          onCommitted={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByPlaceholderText('Model name')).toHaveValue('My local edit');
    expect(screen.getByPlaceholderText('Artist name (optional)')).toHaveValue('Model Artist');

    rerender(
      <QueryClientProvider client={client}>
        <BatchMetadataForm
          sessionId="session-1"
          originalFilename="Artist - 2024 - Lust.zip"
          detected={detected}
          draftMetadata={{ ...firstDraft, modelName: 'Lust, Homunculus' }}
          resetKey="draft-2"
          onCommitted={vi.fn()}
        />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByPlaceholderText('Model name')).toHaveValue('Lust, Homunculus'));

    fireEvent.change(screen.getByLabelText('year'), { target: { value: '2025' } });
    fireEvent.click(screen.getByLabelText('mature'));
    fireEvent.click(screen.getByRole('button', { name: 'Import one model' }));

    await waitFor(() => expect(commitImportSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        metadata: {
          source: 'Fullmetal Alchemist',
          year: 2025,
          mature: true,
        },
      }),
    ));
  });

  it('prefills the form from a metadata.json the archive carried', async () => {
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
            artist: 'Guessed Artist',
            tagsGuessed: ['guessed'],
            folderStructure: [],
            metadataFile: {
              modelName: 'Dragon Knight',
              description: 'From the archive',
              artist: 'Foo Studios',
              tags: ['dragon'],
            },
          }}
          onCommitted={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByPlaceholderText('Model name')).toHaveValue('Dragon Knight');
    expect(screen.getByPlaceholderText('Description (optional)')).toHaveValue('From the archive');
    expect(screen.getByPlaceholderText('Artist name (optional)')).toHaveValue('Foo Studios');
    expect(screen.getByText('dragon')).toBeTruthy();
    expect(screen.queryByText('guessed')).toBeNull();
  });

  it('does not submit blank optional metadata values from an archive', async () => {
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
            tagsGuessed: [],
            folderStructure: [],
            metadataFile: { metadata: { url: '', source: 'Dragon Quest' } },
          }}
          onCommitted={vi.fn()}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Import one model' }));

    await waitFor(() => expect(commitImportSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ metadata: { source: 'Dragon Quest' } }),
    ));
  });

  it('lets a saved draft win over the archive metadata.json', () => {
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
            tagsGuessed: [],
            folderStructure: [],
            metadataFile: { modelName: 'From File', artist: 'File Artist' },
          }}
          draftMetadata={{ modelName: 'From Draft', artist: 'Draft Artist' }}
          onCommitted={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByPlaceholderText('Model name')).toHaveValue('From Draft');
    expect(screen.getByPlaceholderText('Artist name (optional)')).toHaveValue('Draft Artist');
  });

  it('keeps edits the user has already made when a metadata.json is present', () => {
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
            tagsGuessed: [],
            folderStructure: [],
            metadataFile: { modelName: 'Dragon Knight' },
          }}
          onCommitted={vi.fn()}
        />
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByPlaceholderText('Model name'), {
      target: { value: 'My Own Name' },
    });

    expect(screen.getByPlaceholderText('Model name')).toHaveValue('My Own Name');
  });

  it('falls back to the archive filename when no metadata.json is present', () => {
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
            artist: 'Guessed Artist',
            tagsGuessed: ['guessed'],
            folderStructure: [],
          }}
          onCommitted={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByPlaceholderText('Model name')).toHaveValue('starter');
    expect(screen.getByPlaceholderText('Artist name (optional)')).toHaveValue('Guessed Artist');
    expect(screen.getByText('guessed')).toBeTruthy();
  });

  it('never prefills a collection id from the archive', () => {
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
            tagsGuessed: [],
            folderStructure: [],
            // A UUID from whatever library the archive was built against.
            metadataFile: {
              modelName: 'Dragon',
              collectionId: '99999999-9999-4999-8999-999999999999',
            } as never,
          }}
          onCommitted={vi.fn()}
        />
      </QueryClientProvider>,
    );

    // Nothing is silently selected, so nothing unselectable can be submitted.
    expect(collectionSelect()).toHaveValue('');
  });

  it('does not submit a collection the user was never shown', async () => {
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
            tagsGuessed: [],
            folderStructure: [],
            metadataFile: {
              modelName: 'Dragon',
              collectionId: '99999999-9999-4999-8999-999999999999',
            } as never,
          }}
          onCommitted={vi.fn()}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Import one model' }));

    await waitFor(() => expect(commitImportSession).toHaveBeenCalled());
    expect(vi.mocked(commitImportSession).mock.calls[0][1]).not.toHaveProperty(
      'collectionId',
    );
  });

  it('keeps a saved draft collection when the archive proposes a new one', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(getCollections).mockResolvedValue({
      data: [collection],
      meta: null,
      errors: null,
    });
    client.setQueryData(['collections', { depth: 1 }], [collection]);

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
            metadataFile: { newCollectionName: 'From Archive' },
          }}
          draftMetadata={{ collectionId: collection.id }}
          onCommitted={vi.fn()}
        />
      </QueryClientProvider>,
    );

    // The draft picked an existing collection; the archive must not override it.
    expect(collectionSelect()).toHaveValue(collection.id);
    expect(screen.queryByPlaceholderText('New collection name')).toBeNull();
  });
});
