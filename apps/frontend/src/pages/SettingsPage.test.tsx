import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { DisplayPreferencesProvider } from '../hooks/use-display-preferences';
import { SettingsPage } from './SettingsPage';

vi.mock('../api/metadata', () => ({
  getFields: vi.fn().mockResolvedValue([]),
  deleteField: vi.fn(),
}));

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/settings']}>
          <DisplayPreferencesProvider>{children}</DisplayPreferencesProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('SettingsPage', () => {
  it('provides a direct route back to the library', () => {
    render(<SettingsPage />, { wrapper: makeWrapper() });

    const backLink = screen.getByRole('link', { name: /back to library/i });
    expect(backLink.getAttribute('href')).toBe('/');
  });
});
