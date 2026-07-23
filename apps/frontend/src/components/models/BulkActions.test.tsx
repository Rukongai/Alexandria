import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CollectionDetail } from '@alexandria/shared';
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

import { bulkCollection, bulkDelete, bulkMetadata } from '../../api/bulk';
import { addModelsToCollection, getCollections } from '../../api/collections';
import { getFieldValues } from '../../api/metadata';

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
});
