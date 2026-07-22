import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CollectionDetail } from '@alexandria/shared';
import { BatchMetadataForm } from './BatchMetadataForm';

vi.mock('../../api/collections', () => ({
  getCollections: vi.fn(),
}));

import { getCollections } from '../../api/collections';

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
});
