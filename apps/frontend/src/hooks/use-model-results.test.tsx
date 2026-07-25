import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ApiResponse, ModelCard } from '@alexandria/shared';
import { useModelResults } from './use-model-results';
import type { ModelFilters } from './use-model-filters';

// ---------------------------------------------------------------------------
// Mock the API module
// ---------------------------------------------------------------------------
vi.mock('../api/models', () => ({
  getModels: vi.fn(),
}));

import { getModels } from '../api/models';
const mockGetModels = vi.mocked(getModels);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const PAGE_1_MODELS: ModelCard[] = [
  {
    id: 'model-1',
    name: 'Benchy',
    slug: 'benchy',
    thumbnailUrl: null,
    previewCropX: null,
    previewCropY: null,
    previewCropScale: null,
    metadata: [],
    fileCount: 1,
    totalSizeBytes: 100,
    status: 'ready',
    isDuplicate: false,
    createdAt: '2024-01-01',
  },
  {
    id: 'model-2',
    name: 'Voronoi Vase',
    slug: 'voronoi-vase',
    thumbnailUrl: null,
    previewCropX: null,
    previewCropY: null,
    previewCropScale: null,
    metadata: [],
    fileCount: 2,
    totalSizeBytes: 200,
    status: 'ready',
    isDuplicate: false,
    createdAt: '2024-01-02',
  },
];

const PAGE_2_MODELS: ModelCard[] = [
  {
    id: 'model-3',
    name: 'Gyroid Infill',
    slug: 'gyroid-infill',
    thumbnailUrl: null,
    previewCropX: null,
    previewCropY: null,
    previewCropScale: null,
    metadata: [],
    fileCount: 3,
    totalSizeBytes: 300,
    status: 'ready',
    isDuplicate: false,
    createdAt: '2024-01-03',
  },
];

const PAGE_1_RESPONSE: ApiResponse<ModelCard[]> = {
  data: PAGE_1_MODELS,
  meta: { total: 3, cursor: 'cursor-page-2', pageSize: 2 },
  errors: null,
};

const PAGE_2_RESPONSE: ApiResponse<ModelCard[]> = {
  data: PAGE_2_MODELS,
  meta: { total: 3, cursor: null, pageSize: 2 },
  errors: null,
};

const DEFAULT_FILTERS: ModelFilters = {
  q: '',
  tags: [],
  sort: undefined,
  sortDir: undefined,
  status: undefined,
  collectionId: undefined,
  metadataFilters: {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stub IntersectionObserver so the hook's useEffect doesn't throw. */
function stubIntersectionObserver() {
  const stub = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    disconnect: vi.fn(),
    unobserve: vi.fn(),
  }));
  global.IntersectionObserver = stub as unknown as typeof IntersectionObserver;
  return stub;
}

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useModelResults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubIntersectionObserver();
  });

  it('flattens pages into models and exposes total from first page meta', async () => {
    mockGetModels.mockResolvedValueOnce(PAGE_1_RESPONSE);

    const { result } = renderHook(
      () =>
        useModelResults({
          filters: DEFAULT_FILTERS,
          toApiParams: (cursor) => (cursor ? { cursor } : {}),
        }),
      { wrapper: makeWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.models).toEqual(PAGE_1_MODELS);
    expect(result.current.total).toBe(3);
  });

  it('exposes hasNextPage true when the last page has a non-null cursor', async () => {
    mockGetModels.mockResolvedValueOnce(PAGE_1_RESPONSE);

    const { result } = renderHook(
      () =>
        useModelResults({
          filters: DEFAULT_FILTERS,
          toApiParams: () => ({}),
        }),
      { wrapper: makeWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.hasNextPage).toBe(true);
  });

  it('exposes hasNextPage false when the last page has a null cursor', async () => {
    mockGetModels.mockResolvedValueOnce(PAGE_2_RESPONSE);

    const { result } = renderHook(
      () =>
        useModelResults({
          filters: DEFAULT_FILTERS,
          toApiParams: () => ({}),
        }),
      { wrapper: makeWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.hasNextPage).toBe(false);
  });

  it('returns a sentinelRef pointing to an HTMLDivElement', async () => {
    mockGetModels.mockResolvedValueOnce(PAGE_1_RESPONSE);

    const { result } = renderHook(
      () =>
        useModelResults({
          filters: DEFAULT_FILTERS,
          toApiParams: () => ({}),
        }),
      { wrapper: makeWrapper() }
    );

    // The ref object is always present (even before the sentinel is mounted in DOM)
    expect(result.current.sentinelRef).toBeDefined();
    expect(typeof result.current.sentinelRef).toBe('object');
    expect('current' in result.current.sentinelRef).toBe(true);
  });

  it('flattens two pages into a combined models array', async () => {
    // Page 1: has cursor -> page 2 will be fetched on demand
    mockGetModels
      .mockResolvedValueOnce(PAGE_1_RESPONSE)
      .mockResolvedValueOnce(PAGE_2_RESPONSE);

    const { result } = renderHook(
      () =>
        useModelResults({
          filters: DEFAULT_FILTERS,
          toApiParams: (cursor) => (cursor ? { cursor } : {}),
        }),
      { wrapper: makeWrapper() }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Manually trigger fetchNextPage (IntersectionObserver won't fire in jsdom)
    result.current.fetchNextPage();

    await waitFor(() => expect(result.current.models).toHaveLength(3));

    expect(result.current.models).toEqual([...PAGE_1_MODELS, ...PAGE_2_MODELS]);
    expect(result.current.hasNextPage).toBe(false);
  });
});
