import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { CollectionDetail, LibrarySummary, MetadataFieldValue } from '@alexandria/shared';
import { AxisFacetBody } from './AxisFacetBody';
import { BatchMetadataForm } from '../upload/BatchMetadataForm';
import { LibraryProvider } from '../../hooks/use-libraries';

// ---------------------------------------------------------------------------
// Mock API modules
// ---------------------------------------------------------------------------
vi.mock('../../api/collections', () => ({
  getCollections: vi.fn(),
}));

vi.mock('../../api/metadata', () => ({
  getFields: vi.fn(),
  getFieldValues: vi.fn(),
}));

vi.mock('../../api/libraries', () => ({
  listLibraries: vi.fn(),
}));

vi.mock('../../hooks/use-auth', () => ({
  useAuth: () => ({
    user: { id: 'user-1' },
    isLoading: false,
    isAuthenticated: true,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

import { getCollections } from '../../api/collections';
import { getFields, getFieldValues } from '../../api/metadata';
import { listLibraries } from '../../api/libraries';

const mockGetCollections = vi.mocked(getCollections);
const mockGetFieldValues = vi.mocked(getFieldValues);
const mockGetFields = vi.mocked(getFields);
const mockListLibraries = vi.mocked(listLibraries);

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const TAGS: MetadataFieldValue[] = [
  { value: 'miniature', modelCount: 14 },
  { value: 'terrain', modelCount: 7 },
  { value: 'functional', modelCount: 3 },
];

const ARTISTS: MetadataFieldValue[] = [
  { value: 'Prusa', modelCount: 22 },
  { value: 'Bambu', modelCount: 11 },
];

const METADATA_FIELDS = [
  { id: 'field-1', name: 'Scale', slug: 'scale', type: 'enum' as const, isDefault: false, isFilterable: true, isBrowsable: true, config: null, sortOrder: 1 },
  { id: 'field-2', name: 'Private Notes', slug: 'private-notes', type: 'text' as const, isDefault: false, isFilterable: false, isBrowsable: false, config: null, sortOrder: 2 },
];

const COLLECTION: CollectionDetail = {
  id: 'collection-1',
  name: 'Figures',
  slug: 'figures',
  description: null,
  parentCollectionId: null,
  children: [],
  modelCount: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const LIBRARY: LibrarySummary = {
  id: 'library-1',
  name: 'Models',
  slug: 'models',
  userId: 'user-1',
  isDefault: true,
  color: 'amber',
  modelCount: 3,
  collectionCount: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
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
          {children}
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

function makeLibraryWrapper(initialUrl = '/lib/library-1') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[initialUrl]}>
          <LibraryProvider>
            {children}
            <LocationProbe />
          </LibraryProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  mockGetFields.mockResolvedValue(METADATA_FIELDS);
});

describe('AxisFacetBody — tags axis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetFieldValues.mockResolvedValue(TAGS);
    mockGetCollections.mockResolvedValue({ data: [], meta: null, errors: null });
  });

  it('renders a FacetItem for each returned tag value with its count', async () => {
    render(<AxisFacetBody axis="tags" />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByText('miniature')).toBeTruthy();
      expect(screen.getByText('terrain')).toBeTruthy();
      expect(screen.getByText('functional')).toBeTruthy();
    });

    expect(screen.getByText('14')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('clicking a tag item adds it to the URL tags param', async () => {
    render(<AxisFacetBody axis="tags" />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('miniature')).toBeTruthy());

    const btn = screen.getByRole('button', { name: /miniature/i });
    expect(btn.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(btn);

    await waitFor(() => {
      // After toggling, aria-pressed should become true
      expect(btn.getAttribute('aria-pressed')).toBe('true');
    });
  });

  it('clicking an active tag removes it (toggles off)', async () => {
    // Start with miniature already in the URL
    render(<AxisFacetBody axis="tags" />, {
      wrapper: makeWrapper('/?tags=miniature'),
    });

    await waitFor(() => expect(screen.getByText('miniature')).toBeTruthy());

    const btn = screen.getByRole('button', { name: /miniature/i });
    expect(btn.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(btn);

    await waitFor(() => {
      expect(btn.getAttribute('aria-pressed')).toBe('false');
    });
  });

  it('returns to library browsing when a tag is selected from a model page', async () => {
    render(<AxisFacetBody axis="tags" />, {
      wrapper: makeWrapper('/models/model-1?axis=tags'),
    });

    await waitFor(() => expect(screen.getByText('miniature')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /miniature/i }));

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/?axis=tags&tags=miniature'
      );
    });
  });

  it('shows empty state when no tags are returned', async () => {
    mockGetFieldValues.mockResolvedValue([]);
    render(<AxisFacetBody axis="tags" />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByText(/no tags found/i)).toBeTruthy();
    });
  });
});

describe('AxisFacetBody — artists axis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetFieldValues.mockResolvedValue(ARTISTS);
    mockGetCollections.mockResolvedValue({ data: [], meta: null, errors: null });
  });

  it('renders a FacetItem for each artist with its count', async () => {
    render(<AxisFacetBody axis="artists" />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Prusa')).toBeTruthy();
      expect(screen.getByText('Bambu')).toBeTruthy();
    });

    expect(screen.getByText('22')).toBeTruthy();
    expect(screen.getByText('11')).toBeTruthy();
  });

  it('marks the active artist from URL param as aria-pressed=true', async () => {
    render(<AxisFacetBody axis="artists" />, {
      wrapper: makeWrapper('/?meta_artist=Prusa'),
    });

    await waitFor(() => expect(screen.getByText('Prusa')).toBeTruthy());

    const prusaBtn = screen.getByRole('button', { name: /prusa/i });
    expect(prusaBtn.getAttribute('aria-pressed')).toBe('true');

    const bambuBtn = screen.getByRole('button', { name: /bambu/i });
    expect(bambuBtn.getAttribute('aria-pressed')).toBe('false');
  });

  it('clicking an artist sets it as active', async () => {
    render(<AxisFacetBody axis="artists" />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByText('Prusa')).toBeTruthy());

    const btn = screen.getByRole('button', { name: /prusa/i });
    expect(btn.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(btn);

    await waitFor(() => {
      expect(btn.getAttribute('aria-pressed')).toBe('true');
    });
  });

  it('shows empty state when no artists are returned', async () => {
    mockGetFieldValues.mockResolvedValue([]);
    render(<AxisFacetBody axis="artists" />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByText(/no artists found/i)).toBeTruthy();
    });
  });
});

describe('AxisFacetBody — metadata axis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetFieldValues.mockResolvedValue([
      { value: '1:12', modelCount: 8 },
      { value: '1:24', modelCount: 3 },
    ]);
  });

  it('fetches and renders values and counts for the axis field', async () => {
    render(<AxisFacetBody axis="metadata:scale" />, { wrapper: makeWrapper() });

    expect(await screen.findByText('1:12')).toBeTruthy();
    expect(screen.getByText('8')).toBeTruthy();
    expect(mockGetFieldValues).toHaveBeenCalledWith('scale');
  });

  it('toggles the field value through its meta_<slug> URL filter', async () => {
    render(<AxisFacetBody axis="metadata:scale" />, {
      wrapper: makeWrapper('/?axis=metadata%3Ascale'),
    });
    const value = await screen.findByRole('button', { name: /1:12/i });
    fireEvent.click(value);

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(
      '/?axis=metadata%3Ascale&meta_scale=1%3A12'
    ));
    fireEvent.click(value);
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(
      '/?axis=metadata%3Ascale'
    ));
  });

  it.each([
    ['unknown', 'metadata:unknown'],
    ['non-browsable', 'metadata:private-notes'],
    ['reserved tags', 'metadata:tags'],
  ] as const)('does not fetch facet values for a %s metadata axis', async (_case, axis) => {
    render(<AxisFacetBody axis={axis} />, { wrapper: makeWrapper() });

    if (axis !== 'metadata:tags') {
      await waitFor(() => expect(mockGetFields).toHaveBeenCalled());
    }
    expect(mockGetFieldValues).not.toHaveBeenCalled();
  });
});

describe('AxisFacetBody — collections axis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetFieldValues.mockResolvedValue([]);
    mockGetCollections.mockResolvedValue({ data: [], meta: null, errors: null });
    mockListLibraries.mockResolvedValue({ data: [LIBRARY], meta: null, errors: null });
  });

  it('renders the collections axis without crashing', async () => {
    const { container } = render(<AxisFacetBody axis="collections" />, {
      wrapper: makeWrapper(),
    });

    await waitFor(() => {
      // CollectionTree renders empty state
      expect(container).toBeTruthy();
    });
  });

  it('should keep the active library route when a collection is selected', async () => {
    mockGetCollections.mockResolvedValue({ data: [COLLECTION], meta: null, errors: null });
    render(<AxisFacetBody axis="collections" />, {
      wrapper: makeLibraryWrapper(),
    });

    await waitFor(() => expect(screen.getByText('Figures')).toBeTruthy());
    fireEvent.click(screen.getByText('Figures'));

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/lib/library-1?collectionId=collection-1'
      );
    });
  });

  it('keeps upload-form collection data from corrupting the shared collection cache', async () => {
    mockGetCollections.mockResolvedValue({ data: [COLLECTION], meta: null, errors: null });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );

    const { rerender } = render(
      <BatchMetadataForm
        sessionId="session-1"
        originalFilename="model.zip"
        detected={{
          modelCount: 1,
          fileCount: 1,
          totalSizeBytes: 100,
          artist: null,
          tagsGuessed: [],
          folderStructure: [],
        }}
        onCommitted={() => {}}
      />,
      { wrapper },
    );

    await waitFor(() => expect(screen.getByRole('option', { name: 'Figures' })).toBeTruthy());

    rerender(
      <>
        <BatchMetadataForm
          sessionId="session-1"
          originalFilename="model.zip"
          detected={{
            modelCount: 1,
            fileCount: 1,
            totalSizeBytes: 100,
            artist: null,
            tagsGuessed: [],
            folderStructure: [],
          }}
          onCommitted={() => {}}
        />
        <AxisFacetBody axis="collections" />
      </>,
    );

    await waitFor(() => expect(screen.getAllByText('Figures').length).toBeGreaterThan(1));
    expect(client.getQueryData(['collections'])).toEqual([COLLECTION]);
    expect(client.getQueryData(['collections', { depth: 1 }])).toEqual([COLLECTION]);
  });
});
