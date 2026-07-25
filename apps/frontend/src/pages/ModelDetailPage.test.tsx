import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { CompressFolderResponse, ModelDetail } from '@alexandria/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelDetailPage } from './ModelDetailPage';

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
}));

vi.mock('../hooks/use-toast', () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock('../api/collections', () => ({
  addModelsToCollection: vi.fn(),
  getCollections: vi.fn(),
}));

vi.mock('../api/models', () => ({
  compressModelFolder: vi.fn(),
  createModelFolder: vi.fn(),
  deleteModelFile: vi.fn(),
  deleteModelFolder: vi.fn(),
  extractModelArchive: vi.fn(),
  getModel: vi.fn(),
  getModelFiles: vi.fn(),
  getModels: vi.fn(),
  mergeModels: vi.fn(),
  splitModelFolder: vi.fn(),
  updateModelFile: vi.fn(),
  updateModelFolder: vi.fn(),
  uploadModelFiles: vi.fn(),
}));

vi.mock('../components/models/ModelHero', () => ({
  ModelHero: () => <div>Model hero</div>,
}));

vi.mock('../components/models/ModelBreadcrumb', () => ({
  ModelBreadcrumb: () => <div>Model breadcrumb</div>,
}));

vi.mock('../components/models/ModelViewer3DModal', () => ({
  ModelViewer3DModal: () => null,
}));

vi.mock('../components/models/TextFilePreviewModal', () => ({
  TextFilePreviewModal: () => null,
}));

vi.mock('../components/models/ModelDetailSkeleton', () => ({
  ModelDetailSkeleton: () => <div>Loading model</div>,
}));

interface DetailPanelTestProps {
  collectionAddPending: boolean;
  onAddToCollections: (collectionIds: string[]) => Promise<void>;
  onSplitFolder: (path: string, name: string) => void;
  fileActionsDisabled?: boolean;
  fileActionStatus?: string;
  onCompressFolder?: (path: string, name: string) => void;
}

vi.mock('../components/models/ModelDetailPanel', () => ({
  ModelDetailPanel: ({
    collectionAddPending,
    onAddToCollections,
    fileActionsDisabled,
    fileActionStatus,
    onCompressFolder,
    onSplitFolder,
  }: DetailPanelTestProps) => (
    <>
      <button
        type="button"
        disabled={collectionAddPending}
        onClick={() => {
          void onAddToCollections(['collection-fails', 'collection-delayed']).catch(() => undefined);
        }}
      >
        {collectionAddPending ? 'Adding collections' : 'Add collections'}
      </button>
      <button type="button" onClick={() => onSplitFolder('variants/large', 'large')}>
        Split folder
      </button>
      <button
        type="button"
        disabled={fileActionsDisabled}
        onClick={() => onCompressFolder?.('parts', 'parts')}
      >
        {fileActionStatus ?? 'Compress folder'}
      </button>
    </>
  ),
}));

import { addModelsToCollection, getCollections } from '../api/collections';
import {
  compressModelFolder,
  getModel,
  getModelFiles,
  splitModelFolder,
} from '../api/models';

const model: ModelDetail = {
  id: 'model-1',
  name: 'Benchy',
  slug: 'benchy',
  description: null,
  thumbnailUrl: null,
  previewImageFileId: null,
  previewCropX: null,
  previewCropY: null,
  previewCropScale: null,
  metadata: [],
  sourceType: 'manual',
  originalFilename: null,
  fileCount: 0,
  totalSizeBytes: 0,
  status: 'ready',
  collections: [],
  images: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function renderPage(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/models/model-1']}>
        <Routes>
          <Route path="/models/model-new" element={<div>New model destination</div>} />
          <Route path="/models/:id" element={<ModelDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ModelDetailPage mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getModel).mockResolvedValue(model);
    vi.mocked(getModelFiles).mockResolvedValue([]);
    vi.mocked(getCollections).mockResolvedValue({ data: [], meta: null, errors: null });
  });

  it('should wait for every collection request before reporting a partial failure and invalidating caches', async () => {
    const delayedRequest = deferred<void>();
    vi.mocked(addModelsToCollection)
      .mockRejectedValueOnce(new Error('first request failed'))
      .mockReturnValueOnce(delayedRequest.promise);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
    renderPage(queryClient);

    fireEvent.click(await screen.findByRole('button', { name: 'Add collections' }));

    await waitFor(() => {
      expect(addModelsToCollection).toHaveBeenNthCalledWith(
        1,
        'collection-fails',
        ['model-1'],
      );
      expect(addModelsToCollection).toHaveBeenNthCalledWith(
        2,
        'collection-delayed',
        ['model-1'],
      );
      expect(screen.getByRole('button', { name: 'Adding collections' })).toBeDisabled();
    });
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();

    delayedRequest.resolve();

    await waitFor(() => {
      expect(mocks.toast).toHaveBeenCalledWith({
        title: 'Could not add to collections',
        description: '1 of 2 collection updates failed.',
        variant: 'destructive',
      });
    });

    for (const queryKey of [
      ['model', 'model-1'],
      ['models'],
      ['collections'],
      ['collection'],
      ['collection-models'],
      ['search'],
      ['smart-collection'],
      ['smart-collections'],
      ['smart-preview'],
    ]) {
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey });
    }
  });

  it('splits a folder, refreshes source and discovery caches, then opens the new model', async () => {
    vi.mocked(getModel).mockResolvedValueOnce({
      ...model,
      metadata: [
        {
          fieldSlug: 'artist',
          fieldName: 'Artist',
          type: 'text',
          value: 'Printed Obsession',
          displayValue: 'Printed Obsession',
        },
      ],
    });
    vi.mocked(splitModelFolder).mockResolvedValue({
      sourceModelId: 'model-1',
      newModelId: 'model-new',
      movedFileCount: 3,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
    renderPage(queryClient);

    fireEvent.click(await screen.findByRole('button', { name: 'Split folder' }));

    expect(screen.getByLabelText('New model name')).toHaveValue('large');
    fireEvent.change(screen.getByLabelText('New model name'), {
      target: { value: 'Large Benchy' },
    });
    fireEvent.click(screen.getByLabelText('Artist'));
    fireEvent.click(screen.getByRole('button', { name: 'Create Model' }));

    await waitFor(() => {
      expect(splitModelFolder).toHaveBeenCalledWith('model-1', {
        path: 'variants/large',
        name: 'Large Benchy',
        metadataFieldSlugs: ['artist'],
      });
    });

    expect(await screen.findByText('New model destination')).toBeInTheDocument();
    expect(mocks.toast).toHaveBeenCalledWith({
      title: 'Large Benchy created',
      description: '3 files moved to the new model.',
    });
    for (const queryKey of [
      ['model', 'model-1'],
      ['model-files', 'model-1'],
      ['models'],
      ['search'],
      ['field-values'],
    ]) {
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey });
    }
  });

  it('should show compression progress, refresh model data, and name the created archive', async () => {
    const compression = deferred<CompressFolderResponse>();
    vi.mocked(compressModelFolder).mockReturnValue(compression.promise);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
    renderPage(queryClient);

    fireEvent.click(await screen.findByRole('button', { name: 'Compress folder' }));

    await waitFor(() => {
      expect(compressModelFolder).toHaveBeenCalledWith('model-1', 'parts');
      expect(screen.getByRole('button', { name: 'Compressing folder…' })).toBeDisabled();
    });
    expect(mocks.toast).not.toHaveBeenCalled();

    compression.resolve({
      archiveFileId: 'archive-1',
      archivePath: 'parts.7z',
      sizeBytes: 2048,
    });

    await waitFor(() => {
      expect(mocks.toast).toHaveBeenCalledWith({ title: 'Created parts.7z' });
    });
    for (const queryKey of [
      ['model', 'model-1'],
      ['model-files', 'model-1'],
      ['models'],
    ]) {
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey });
    }
  });
});
