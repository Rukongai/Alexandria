import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { UserProfile } from '@alexandria/shared';
import { ThemeProvider } from '../../hooks/use-theme';
import { PivotRail } from './PivotRail';

// jsdom does not implement matchMedia — provide a minimal stub
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

// ---------------------------------------------------------------------------
// Mock API modules (used by AxisFacetBody)
// ---------------------------------------------------------------------------
vi.mock('../../api/collections', () => ({
  getCollections: vi.fn(),
}));

vi.mock('../../api/metadata', () => ({
  getFieldValues: vi.fn(),
}));

// Mock useAuth so the component doesn't require a real AuthProvider
vi.mock('../../hooks/use-auth', () => ({
  useAuth: vi.fn(),
}));

// Mock useNavigate (used by UserMenu)
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

import { getCollections } from '../../api/collections';
import { getFieldValues } from '../../api/metadata';
import { useAuth } from '../../hooks/use-auth';

const mockGetCollections = vi.mocked(getCollections);
const mockGetFieldValues = vi.mocked(getFieldValues);
const mockUseAuth = vi.mocked(useAuth);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const FAKE_USER: UserProfile = {
  id: 'user-1',
  email: 'joseph@josephrankin.com',
  displayName: 'Joseph Rankin',
  role: 'admin',
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
          <ThemeProvider>{children}</ThemeProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('PivotRail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCollections.mockResolvedValue({ data: [], meta: null, errors: null });
    mockGetFieldValues.mockResolvedValue([]);
    mockUseAuth.mockReturnValue({
      user: FAKE_USER,
      isLoading: false,
      isAuthenticated: true,
      login: vi.fn(),
      logout: vi.fn(),
    });
  });

  it('renders all three axis buttons', async () => {
    render(<PivotRail />, { wrapper: makeWrapper() });

    expect(screen.getByRole('button', { name: /collections/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /artists/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /tags/i })).toBeTruthy();
  });

  it('clicking Tags makes Tags axis active', async () => {
    render(<PivotRail />, { wrapper: makeWrapper() });

    const collectionsBtn = screen.getByRole('button', { name: /collections/i });
    const tagsBtn = screen.getByRole('button', { name: /tags/i });

    expect(collectionsBtn.getAttribute('aria-pressed')).toBe('true');
    expect(tagsBtn.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(tagsBtn);

    await waitFor(() => {
      expect(tagsBtn.getAttribute('aria-pressed')).toBe('true');
      expect(collectionsBtn.getAttribute('aria-pressed')).toBe('false');
    });
  });

  it('shows the user display name in the footer', async () => {
    render(<PivotRail />, { wrapper: makeWrapper() });

    expect(screen.getByText('Joseph Rankin')).toBeTruthy();
  });

  it('shows the user initials in the avatar', async () => {
    render(<PivotRail />, { wrapper: makeWrapper() });

    // AvatarFallback shows initials derived from "Joseph Rankin" → "JR"
    expect(screen.getByText('JR')).toBeTruthy();
  });

  it('the library-switcher stub is disabled (aria-disabled + tabIndex=-1)', async () => {
    render(<PivotRail />, { wrapper: makeWrapper() });

    // The stub button has aria-disabled="true" and tabIndex -1
    const stubBtn = screen.getByTitle(/library switching coming soon/i);
    expect(stubBtn.getAttribute('aria-disabled')).toBe('true');
    expect(stubBtn.getAttribute('tabindex')).toBe('-1');
  });

  it('reflects axis=tags from the URL in the axis picker', async () => {
    render(<PivotRail />, { wrapper: makeWrapper('/?axis=tags') });

    const tagsBtn = screen.getByRole('button', { name: /tags/i });
    expect(tagsBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('renders the Alexandria brand name', async () => {
    render(<PivotRail />, { wrapper: makeWrapper() });

    expect(screen.getByText('Alexandria')).toBeTruthy();
  });
});
