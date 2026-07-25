import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CollectionDetail, ModelCard } from '@alexandria/shared';
import { BulkActions } from './BulkActions';

vi.mock('../../api/bulk', () => ({
  bulkCollection: vi.fn(),
  bulkDelete: vi.fn(),
  bulkMetadata: vi.fn(),
}));

vi.mock('../../api/collections', () => ({
  addModelsToCollection: vi.fn(),
  getCollections: vi.fn(),
}));

vi.mock('../../api/metadata', () => ({
  getFieldValues: vi.fn(),
}));

vi.mock('../../api/models', () => ({
  getModel: vi.fn(),
  mergeModels: vi.fn(),
}));

import { bulkCollection, bulkDelete, bulkMetadata } from '../../api/bulk';
import { addModelsToCollection, getCollections } from '../../api/collections';
import { getFieldValues } from '../../api/metadata';
import { getModel, mergeModels } from '../../api/models';

function modelCard(overrides: Partial<ModelCard> & Pick<ModelCard, 'id' | 'name'>): ModelCard {
  return {
    slug: overrides.id,
    thumbnailUrl: null,
    previewCropX: null,
    previewCropY: null,
    previewCropScale: null,
    metadata: [],
    fileCount: 2,
    totalSizeBytes: 1024,
    status: 'ready',
    isDuplicate: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const target: CollectionDetail = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Print Queue',
  slug: 'print-queue',
  description: null,
  parentCollectionId: null,
  modelCount: 3,
  children: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function Wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('BulkActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getFieldValues).mockResolvedValue([]);
  });

  it('adds tags to selected models without replacing their existing tags', async () => {
    vi.mocked(getFieldValues).mockResolvedValue([{ value: 'Fantasy', modelCount: 4 }]);
    vi.mocked(bulkMetadata).mockResolvedValue(undefined);
    const onComplete = vi.fn();

    render(
      <BulkActions
        selectedIds={new Set(['model-1', 'model-2'])}
        models={[]}
        onClear={vi.fn()}
        onComplete={onComplete}
      />,
      { wrapper: Wrapper },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Tag' }));
    await waitFor(() => expect(screen.getByRole('option', { name: /Fantasy/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('option', { name: /Fantasy/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 tag' }));

    await waitFor(() => {
      expect(bulkMetadata).toHaveBeenCalledWith({
        modelIds: ['model-1', 'model-2'],
        operations: [{ fieldSlug: 'tags', action: 'add', value: ['Fantasy'] }],
      });
      expect(onComplete).toHaveBeenCalledOnce();
    });
  });

  it('applies a newly typed tag without requiring Enter first', async () => {
    vi.mocked(bulkMetadata).mockResolvedValue(undefined);

    render(
      <BulkActions
        selectedIds={new Set(['model-1'])}
        models={[]}
        onClear={vi.fn()}
        onComplete={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Tag' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Tag name' }), {
      target: { value: 'New Tag' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 tag' }));

    await waitFor(() => {
      expect(bulkMetadata).toHaveBeenCalledWith({
        modelIds: ['model-1'],
        operations: [{ fieldSlug: 'tags', action: 'add', value: ['New Tag'] }],
      });
    });
  });

  it('moves selected models to the chosen collection', async () => {
    vi.mocked(getCollections).mockResolvedValue({ data: [target], meta: null, errors: null });
    vi.mocked(bulkCollection).mockResolvedValue(undefined);
    const onComplete = vi.fn();

    render(
      <BulkActions
        selectedIds={new Set(['model-1', 'model-2'])}
        models={[]}
        onClear={vi.fn()}
        onComplete={onComplete}
      />,
      { wrapper: Wrapper },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(screen.getByText('Print Queue')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Print Queue/ }));

    await waitFor(() => {
      expect(bulkCollection).toHaveBeenCalledWith({
        modelIds: ['model-1', 'model-2'],
        action: 'move',
        collectionId: target.id,
      });
      expect(onComplete).toHaveBeenCalledOnce();
    });
  });

  it('should add selected models while keeping their existing collection memberships', async () => {
    vi.mocked(getCollections).mockResolvedValue({ data: [target], meta: null, errors: null });
    vi.mocked(addModelsToCollection).mockResolvedValue(undefined);
    const onComplete = vi.fn();

    render(
      <BulkActions
        selectedIds={new Set(['model-1', 'model-2'])}
        models={[]}
        onClear={vi.fn()}
        onComplete={onComplete}
      />,
      { wrapper: Wrapper },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add to collection' }));
    expect(screen.getByText('Existing collection memberships will be kept.')).toBeInTheDocument();
    const targetButton = await screen.findByRole('button', { name: 'Add to Print Queue' });
    fireEvent.click(targetButton);

    await waitFor(() => {
      expect(addModelsToCollection).toHaveBeenCalledWith(target.id, ['model-1', 'model-2']);
      expect(bulkCollection).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledOnce();
    });
  });

  it('should expose picker state and restore trigger focus when Escape closes it', async () => {
    vi.mocked(getCollections).mockResolvedValue({ data: [target], meta: null, errors: null });

    render(
      <BulkActions
        selectedIds={new Set(['model-1'])}
        models={[]}
        onClear={vi.fn()}
        onComplete={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    const trigger = screen.getByRole('button', { name: 'Add to collection' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);

    const picker = await screen.findByRole('dialog', { name: 'Add models to collection' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', picker.id);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Add to Print Queue' })).toHaveFocus();
    });

    fireEvent.keyDown(picker, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Add models to collection' })).not.toBeInTheDocument();
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(trigger).toHaveFocus();
    });
  });

  it('requires confirmation before deleting selected models', async () => {
    vi.mocked(bulkDelete).mockResolvedValue(undefined);
    const onComplete = vi.fn();

    render(
      <BulkActions
        selectedIds={new Set(['model-1'])}
        models={[]}
        onClear={vi.fn()}
        onComplete={onComplete}
      />,
      { wrapper: Wrapper },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Delete 1 model?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete 1 model' }));

    await waitFor(() => {
      expect(bulkDelete).toHaveBeenCalledWith({ modelIds: ['model-1'] });
      expect(onComplete).toHaveBeenCalledOnce();
    });
  });

  describe('merge', () => {
    const dragon = modelCard({ id: 'model-1', name: 'Dragon' });
    const knight = modelCard({ id: 'model-2', name: 'Knight' });

    it('hides the merge action until at least two models are selected', () => {
      const { rerender } = render(
        <BulkActions
          selectedIds={new Set(['model-1'])}
          models={[dragon, knight]}
          onClear={vi.fn()}
          onComplete={vi.fn()}
        />,
        { wrapper: Wrapper },
      );

      expect(screen.queryByRole('button', { name: 'Merge' })).not.toBeInTheDocument();

      rerender(
        <BulkActions
          selectedIds={new Set(['model-1', 'model-2'])}
          models={[dragon, knight]}
          onClear={vi.fn()}
          onComplete={vi.fn()}
        />,
      );

      expect(screen.getByRole('button', { name: 'Merge' })).toBeInTheDocument();
    });

    it('merges the other selected models into the chosen target', async () => {
      vi.mocked(mergeModels).mockResolvedValue({
        targetModelId: 'model-2',
        mergedModelIds: ['model-1'],
        movedFileCount: 2,
      });
      const onComplete = vi.fn();

      render(
        <BulkActions
          selectedIds={new Set(['model-1', 'model-2'])}
          models={[dragon, knight]}
          onClear={vi.fn()}
          onComplete={onComplete}
        />,
        { wrapper: Wrapper },
      );

      fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
      fireEvent.click(screen.getByRole('radio', { name: /Knight/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Merge 1 model in' }));

      await waitFor(() => {
        expect(mergeModels).toHaveBeenCalledWith('model-2', ['model-1']);
        expect(onComplete).toHaveBeenCalledOnce();
      });
    });

    it('keeps merge disabled until a target is chosen', () => {
      render(
        <BulkActions
          selectedIds={new Set(['model-1', 'model-2'])}
          models={[dragon, knight]}
          onClear={vi.fn()}
          onComplete={vi.fn()}
        />,
        { wrapper: Wrapper },
      );

      fireEvent.click(screen.getByRole('button', { name: 'Merge' }));

      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByRole('button', { name: 'Merge' })).toBeDisabled();
    });

    it('excludes models that are not ready from the merge', async () => {
      vi.mocked(mergeModels).mockResolvedValue({
        targetModelId: 'model-1',
        mergedModelIds: ['model-2'],
        movedFileCount: 2,
      });
      const processing = modelCard({ id: 'model-3', name: 'Wyvern', status: 'processing' });

      render(
        <BulkActions
          selectedIds={new Set(['model-1', 'model-2', 'model-3'])}
          models={[dragon, knight, processing]}
          onClear={vi.fn()}
          onComplete={vi.fn()}
        />,
        { wrapper: Wrapper },
      );

      fireEvent.click(screen.getByRole('button', { name: 'Merge' }));

      expect(screen.getByText('1 selected model is not ready and will be skipped.')).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: /Wyvern/ })).toBeDisabled();

      fireEvent.click(screen.getByRole('radio', { name: /Dragon/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Merge 1 model in' }));

      await waitFor(() => {
        expect(mergeModels).toHaveBeenCalledWith('model-1', ['model-2']);
      });
    });

    it('blocks the merge when a selected model outside the loaded page cannot be loaded', async () => {
      vi.mocked(getModel).mockRejectedValue(new Error('Not found'));

      render(
        <BulkActions
          selectedIds={new Set(['model-1', 'model-2', 'model-9'])}
          models={[dragon, knight]}
          onClear={vi.fn()}
          onComplete={vi.fn()}
        />,
        { wrapper: Wrapper },
      );

      fireEvent.click(screen.getByRole('button', { name: 'Merge' }));

      const dialog = screen.getByRole('dialog');
      await waitFor(() => {
        expect(
          screen.getByText(/1 selected model could not be loaded/),
        ).toBeInTheDocument();
      });

      // A truncated candidate list must not be mergeable, even with a valid target picked.
      fireEvent.click(screen.getByRole('radio', { name: /Dragon/ }));
      expect(within(dialog).getByRole('button', { name: 'Merge' })).toBeDisabled();
      expect(mergeModels).not.toHaveBeenCalled();
    });

    it('blocks the merge when the selection exceeds the source cap', () => {
      const many = Array.from({ length: 103 }, (_, index) =>
        modelCard({ id: `model-${index}`, name: `Model ${index}` }),
      );

      render(
        <BulkActions
          selectedIds={new Set(many.map((model) => model.id))}
          models={many}
          onClear={vi.fn()}
          onComplete={vi.fn()}
        />,
        { wrapper: Wrapper },
      );

      fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
      fireEvent.click(screen.getByRole('radio', { name: /Model 0 /i }));

      const dialog = screen.getByRole('dialog');
      expect(
        screen.getByText(/At most 100 models can be merged into one at a time\. Deselect 2/),
      ).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Merge' })).toBeDisabled();
    });

    it('fetches selected models that are no longer in the loaded page', async () => {
      vi.mocked(getModel).mockResolvedValue({
        ...modelCard({ id: 'model-9', name: 'Griffin' }),
        description: null,
        previewImageFileId: null,
        sourceType: 'zip_upload',
        originalFilename: null,
        collections: [],
        images: [],
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      render(
        <BulkActions
          selectedIds={new Set(['model-1', 'model-9'])}
          models={[dragon]}
          onClear={vi.fn()}
          onComplete={vi.fn()}
        />,
        { wrapper: Wrapper },
      );

      fireEvent.click(screen.getByRole('button', { name: 'Merge' }));

      await waitFor(() => {
        expect(getModel).toHaveBeenCalledWith('model-9');
        expect(screen.getByRole('radio', { name: /Griffin/ })).toBeInTheDocument();
      });
    });
  });
});
