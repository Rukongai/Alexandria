import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MetadataFieldDetail, MetadataValue } from '@alexandria/shared';
import { MetadataPanel } from './MetadataPanel';

vi.mock('../../api/metadata', () => ({
  getFields: vi.fn(),
  getFieldValues: vi.fn(),
  setModelMetadata: vi.fn(),
}));

import { getFields, getFieldValues, setModelMetadata } from '../../api/metadata';

const tagsField: MetadataFieldDetail = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Tags',
  slug: 'tags',
  type: 'multi_enum',
  isDefault: true,
  isFilterable: true,
  isBrowsable: true,
  config: null,
  sortOrder: 1,
};

const metadata: MetadataValue[] = [
  {
    fieldSlug: 'tags',
    fieldName: 'Tags',
    type: 'multi_enum',
    value: ['Fantasy'],
    displayValue: 'Fantasy',
  },
];

describe('MetadataPanel tag editing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getFields).mockResolvedValue([tagsField]);
    vi.mocked(getFieldValues).mockResolvedValue([{ value: 'Terrain', modelCount: 4 }]);
    vi.mocked(setModelMetadata).mockResolvedValue(undefined);
  });

  it('should save a selected library tag when editing the tags field', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateQueries = vi.spyOn(client, 'invalidateQueries');
    render(
      <QueryClientProvider client={client}>
        <MetadataPanel metadata={metadata} modelId="model-1" />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    const input = await screen.findByRole('combobox', { name: 'Tag name' });
    fireEvent.change(input, { target: { value: 'terr' } });
    fireEvent.focus(input);
    fireEvent.click(await screen.findByRole('option', { name: /Terrain/ }));

    expect(screen.getByRole('button', { name: 'Remove tag Terrain' })).toBeInTheDocument();
    expect(getFieldValues).toHaveBeenCalledWith('tags');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(setModelMetadata).toHaveBeenCalledWith('model-1', {
        tags: ['Fantasy', 'Terrain'],
      });
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['field-values', 'tags'],
      });
    });
  });
});
