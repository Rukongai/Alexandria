import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ApiResponse, ModelCard } from '@alexandria/shared';
import { DisplayPreferencesProvider } from '../../hooks/use-display-preferences';
import { PivotMain } from './PivotMain';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

// jsdom doesn't implement matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

/** Stub IntersectionObserver so the hook's useEffect doesn't throw. */
function stubIntersectionObserver() {
  // Must use a regular function (not an arrow function) so it's constructable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function FakeIntersectionObserver(this: any) {
    this.observe = vi.fn();
    this.disconnect = vi.fn();
    this.unobserve = vi.fn();
  }
  global.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
}

// ---------------------------------------------------------------------------
// Mock API
// ---------------------------------------------------------------------------
vi.mock('../../api/models', () => ({
  getModels: vi.fn(),
}));

vi.mock('../../hooks/use-assistant-context', () => ({
  useAssistantTarget: vi.fn(),
}));

import { getModels } from '../../api/models';
import { useAssistantTarget } from '../../hooks/use-assistant-context';
const mockGetModels = vi.mocked(getModels);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const MODELS: ModelCard[] = [
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
    createdAt: '2024-01-02',
  },
];

const MODELS_RESPONSE: ApiResponse<ModelCard[]> = {
  data: MODELS,
  meta: { total: 2, cursor: null, pageSize: 2 },
  errors: null,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeWrapper(initialUrl = '/') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[initialUrl]}>
          <DisplayPreferencesProvider>
            {children}
          </DisplayPreferencesProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('PivotMain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    stubIntersectionObserver();
    mockGetModels.mockResolvedValue(MODELS_RESPONSE);
  });

  it('renders the search input', () => {
    render(<PivotMain />, { wrapper: makeWrapper() });

    expect(screen.getByRole('searchbox', { name: /search models/i })).toBeTruthy();
  });

  it('renders the Upload action linking to /upload', () => {
    render(<PivotMain />, { wrapper: makeWrapper() });

    const uploadLink = screen.getByRole('link', { name: /upload/i });
    expect(uploadLink.getAttribute('href')).toBe('/upload');
  });

  it('renders model cards after data loads', async () => {
    render(<PivotMain />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Benchy')).toBeTruthy();
      expect(screen.getByText('Voronoi Vase')).toBeTruthy();
    });
  });

  it('should target the current result page and narrow to an explicit selection', async () => {
    render(<PivotMain />, { wrapper: makeWrapper() });

    await waitFor(() => expect(useAssistantTarget).toHaveBeenCalledWith({
      modelIds: ['model-1', 'model-2'],
    }));

    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select model: Benchy' }));

    await waitFor(() => expect(useAssistantTarget).toHaveBeenLastCalledWith({
      modelIds: ['model-1'],
    }));
  });

  it('displays the result count', async () => {
    render(<PivotMain />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByText(/2\s+models/i)).toBeTruthy();
    });
  });

  it('renders the breadcrumb with Library and axis label', async () => {
    render(<PivotMain />, { wrapper: makeWrapper() });

    // Default axis is 'collections'
    expect(screen.getByText('Library')).toBeTruthy();
    expect(screen.getByText('Collections')).toBeTruthy();
  });

  it('shows Artists axis crumb when axis=artists in URL', () => {
    render(<PivotMain />, { wrapper: makeWrapper('/?axis=artists') });

    expect(screen.getByText('Artists')).toBeTruthy();
  });

  it('renders the ViewSwitch with all three buttons', () => {
    render(<PivotMain />, { wrapper: makeWrapper() });

    expect(screen.getByRole('button', { name: /grid view/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /list view/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /group view/i })).toBeTruthy();
  });

  it('shows move and delete actions after selecting a model', async () => {
    render(<PivotMain />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('Benchy')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select model: Benchy' }));

    expect(screen.getByText('1 model selected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
  });

  it('shows an error message when the API fails', async () => {
    mockGetModels.mockRejectedValue(new Error('Network error'));

    render(<PivotMain />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByText(/failed to load models/i)).toBeTruthy();
    });
  });

  it('shows empty state when no models are returned', async () => {
    mockGetModels.mockResolvedValue({
      data: [],
      meta: { total: 0, cursor: null, pageSize: 0 },
      errors: null,
    });

    render(<PivotMain />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByText(/your library is empty/i)).toBeTruthy();
    });
  });
});
