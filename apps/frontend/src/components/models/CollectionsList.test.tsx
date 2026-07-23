import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { CollectionDetail, CollectionSummary } from '@alexandria/shared';
import { CollectionsList } from './CollectionsList';

function makeCollection(
  id: string,
  name: string,
  overrides: Partial<CollectionDetail> = {},
): CollectionDetail {
  return {
    id,
    name,
    slug: name.toLowerCase().replaceAll(' ', '-'),
    description: null,
    parentCollectionId: null,
    children: [],
    modelCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const existingCollection: CollectionSummary = {
  id: 'collection-existing',
  name: 'Favorites',
  slug: 'favorites',
};
const allCollections = [
  makeCollection(existingCollection.id, existingCollection.name),
  makeCollection('collection-print-queue', 'Print Queue'),
  makeCollection('collection-weekend', 'Weekend Projects'),
];

const defaultProps = {
  collections: [existingCollection],
  allCollections,
  isLoading: false,
  isError: false,
  isAdding: false,
  onRetry: vi.fn(),
  onAdd: vi.fn<(_collectionIds: string[]) => Promise<void>>(),
};

function renderList(overrides: Partial<React.ComponentProps<typeof CollectionsList>> = {}) {
  return render(
    <MemoryRouter>
      <CollectionsList {...defaultProps} {...overrides} />
    </MemoryRouter>,
  );
}

describe('CollectionsList', () => {
  it('should keep existing memberships checked and disabled while adding only new selections', async () => {
    const onAdd = vi.fn<(_collectionIds: string[]) => Promise<void>>().mockResolvedValue(undefined);
    renderList({ onAdd });

    const existing = screen.getByRole('checkbox', { name: 'Favorites' });
    expect(existing).toBeChecked();
    expect(existing).toBeDisabled();
    expect(screen.getByText('Already added')).toBeInTheDocument();
    expect(screen.getByText('Existing memberships are kept.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Print Queue' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Weekend Projects' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to 2 collections' }));

    await waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith([
        'collection-print-queue',
        'collection-weekend',
      ]);
    });
    expect(onAdd).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Select collections' })).toBeDisabled();
  });

  it('should disable collection choices and submission while an add is pending', () => {
    const { rerender } = renderList();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Print Queue' }));

    rerender(
      <MemoryRouter>
        <CollectionsList {...defaultProps} isAdding />
      </MemoryRouter>,
    );

    expect(screen.getByRole('checkbox', { name: 'Print Queue' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add to 1 collection' })).toBeDisabled();
  });

  it('should show an actionable error when adding to selected collections fails', async () => {
    const onAdd = vi
      .fn<(_collectionIds: string[]) => Promise<void>>()
      .mockRejectedValue(new Error('request failed'));
    renderList({ onAdd });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Print Queue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to 1 collection' }));

    expect(
      await screen.findByRole('alert'),
    ).toHaveTextContent('The model could not be added to every selected collection. Try again.');
  });

  it('should offer a retry when collections cannot be loaded', () => {
    const onRetry = vi.fn();
    renderList({ isError: true, onRetry });

    expect(screen.getByText('Collections could not be loaded.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(onRetry).toHaveBeenCalledOnce();
  });
});
