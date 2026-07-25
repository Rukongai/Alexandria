import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MetadataFieldDetail } from '@alexandria/shared';
import { AxisPicker } from './AxisPicker';

vi.mock('../../api/metadata', () => ({ getFields: vi.fn() }));

import { getFields } from '../../api/metadata';

const mockGetFields = vi.mocked(getFields);
const FIELDS: MetadataFieldDetail[] = [
  { id: '1', name: 'Artist', slug: 'artist', type: 'text', isDefault: true, isFilterable: true, isBrowsable: true, config: null, sortOrder: 0 },
  { id: '2', name: 'Scale', slug: 'scale', type: 'enum', isDefault: false, isFilterable: true, isBrowsable: true, config: null, sortOrder: 1 },
  { id: '3', name: 'Private Notes', slug: 'private-notes', type: 'text', isDefault: false, isFilterable: false, isBrowsable: false, config: null, sortOrder: 2 },
  { id: '4', name: 'Material', slug: 'material', type: 'text', isDefault: false, isFilterable: true, isBrowsable: true, config: null, sortOrder: 3 },
  { id: '5', name: 'Generated Field', slug: '-abcd', type: 'text', isDefault: false, isFilterable: true, isBrowsable: true, config: null, sortOrder: 4 },
];

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

function BackButton() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(-1)}>Back</button>;
}

function makeWrapper(initialUrl = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

function makeHistoryWrapper(initialEntries: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={initialEntries} initialIndex={initialEntries.length - 1}>
          {children}
          <LocationProbe />
          <BackButton />
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('AxisPicker', () => {
  beforeEach(() => {
    mockGetFields.mockResolvedValue(FIELDS);
  });

  it('renders all three axis buttons', () => {
    render(<AxisPicker />, { wrapper: makeWrapper() });

    expect(screen.getByRole('button', { name: /collections/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /artists/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /tags/i })).toBeTruthy();
  });

  it('marks Collections as active by default (no axis param)', () => {
    render(<AxisPicker />, { wrapper: makeWrapper('/') });

    const collectionsBtn = screen.getByRole('button', { name: /collections/i });
    const artistsBtn = screen.getByRole('button', { name: /artists/i });
    const tagsBtn = screen.getByRole('button', { name: /tags/i });

    expect(collectionsBtn.getAttribute('aria-pressed')).toBe('true');
    expect(artistsBtn.getAttribute('aria-pressed')).toBe('false');
    expect(tagsBtn.getAttribute('aria-pressed')).toBe('false');
  });

  it('marks Artists as active when ?axis=artists is in the URL', () => {
    render(<AxisPicker />, { wrapper: makeWrapper('/?axis=artists') });

    const collectionsBtn = screen.getByRole('button', { name: /collections/i });
    const artistsBtn = screen.getByRole('button', { name: /artists/i });

    expect(collectionsBtn.getAttribute('aria-pressed')).toBe('false');
    expect(artistsBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('marks Tags as active when ?axis=tags is in the URL', () => {
    render(<AxisPicker />, { wrapper: makeWrapper('/?axis=tags') });

    const tagsBtn = screen.getByRole('button', { name: /tags/i });
    expect(tagsBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('clicking Tags updates aria-pressed (axis changes)', () => {
    render(<AxisPicker />, { wrapper: makeWrapper('/') });

    const collectionsBtn = screen.getByRole('button', { name: /collections/i });
    const tagsBtn = screen.getByRole('button', { name: /tags/i });

    expect(collectionsBtn.getAttribute('aria-pressed')).toBe('true');
    expect(tagsBtn.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(tagsBtn);

    expect(tagsBtn.getAttribute('aria-pressed')).toBe('true');
    expect(collectionsBtn.getAttribute('aria-pressed')).toBe('false');
  });

  it('clicking Artists from Collections updates active axis', () => {
    render(<AxisPicker />, { wrapper: makeWrapper('/') });

    const artistsBtn = screen.getByRole('button', { name: /artists/i });
    fireEvent.click(artistsBtn);

    expect(artistsBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('returns to library browsing when an axis is selected from a model page', () => {
    render(<AxisPicker />, { wrapper: makeWrapper('/models/model-1?collectionId=col-1') });

    fireEvent.click(screen.getByRole('button', { name: /tags/i }));

    expect(screen.getByTestId('location')).toHaveTextContent(
      '/?collectionId=col-1&axis=tags'
    );
  });

  it('renders browsable metadata fields in returned order without duplicating built-ins', async () => {
    render(<AxisPicker />, { wrapper: makeWrapper() });

    const scale = await screen.findByRole('button', { name: 'Scale' });
    const material = screen.getByRole('button', { name: 'Material' });
    expect(scale.compareDocumentPosition(material) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Private Notes' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Artists' })).toHaveLength(1);
  });

  it('selects a metadata axis using metadata:<slug> URL encoding', async () => {
    render(<AxisPicker />, { wrapper: makeWrapper() });
    fireEvent.click(await screen.findByRole('button', { name: 'Scale' }));

    expect(screen.getByTestId('location')).toHaveTextContent('/?axis=metadata%3Ascale');
    expect(screen.getByRole('button', { name: 'Scale' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('allows a returned browsable field with a leading-hyphen slug', async () => {
    render(<AxisPicker />, { wrapper: makeWrapper('/?axis=metadata%3A-abcd') });

    const field = await screen.findByRole('button', { name: 'Generated Field' });
    expect(field.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('location').textContent).toBe('/?axis=metadata%3A-abcd');
  });

  it.each([
    ['unknown', 'metadata%3Aunknown'],
    ['non-browsable', 'metadata%3Aprivate-notes'],
    ['reserved tags', 'metadata%3Atags'],
  ])('normalizes a %s metadata axis back to collections', async (_case, encodedAxis) => {
    render(<AxisPicker />, { wrapper: makeWrapper(`/?axis=${encodedAxis}`) });

    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/');
      expect(screen.getByRole('button', { name: 'Collections' }).getAttribute('aria-pressed')).toBe('true');
    });
  });

  it('replaces an invalid browse axis so Back does not revisit cleanup', async () => {
    render(<AxisPicker />, {
      wrapper: makeHistoryWrapper(['/previous', '/?axis=metadata%3Aunknown&q=keep']),
    });

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/?q=keep'));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/previous'));
  });

  it('does not rewrite an invalid dynamic axis on a non-browse pathname', async () => {
    render(<AxisPicker />, {
      wrapper: makeWrapper('/models/model-1?axis=metadata%3Aunknown&q=keep'),
    });

    await screen.findByRole('button', { name: 'Scale' });
    expect(screen.getByTestId('location').textContent).toBe(
      '/models/model-1?axis=metadata%3Aunknown&q=keep'
    );
  });

  it('bounds and scrolls the options region when many fields are browsable', async () => {
    mockGetFields.mockResolvedValue(
      Array.from({ length: 30 }, (_, index): MetadataFieldDetail => ({
        id: `field-${index}`,
        name: `Field ${index}`,
        slug: `field-${index}`,
        type: 'text',
        isDefault: false,
        isFilterable: true,
        isBrowsable: true,
        config: null,
        sortOrder: index,
      }))
    );
    render(<AxisPicker />, { wrapper: makeWrapper() });

    expect(await screen.findByRole('button', { name: 'Field 29' })).toBeTruthy();
    const options = screen.getByRole('group', { name: 'Browse axes' });
    expect(options.className).toContain('max-h-48');
    expect(options.className).toContain('overflow-y-auto');
  });
});
