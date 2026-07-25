import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserMenu } from './UserMenu';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', () => ({ useNavigate: () => mockNavigate }));
vi.mock('../../hooks/use-auth', () => ({
  useAuth: () => ({
    user: {
      id: 'user-1',
      displayName: 'Alex Reader',
      email: 'alex@example.com',
      role: 'admin',
    },
    logout: vi.fn(),
  }),
}));
vi.mock('../../hooks/use-libraries', () => ({
  useLibraryPath: () => (path: string) => `/lib/library-1${path === '/' ? '' : path}`,
}));
vi.mock('../layout/ThemeToggle', () => ({ ThemeToggle: () => <button>Theme</button> }));

describe('UserMenu', () => {
  beforeEach(() => vi.clearAllMocks());

  it('navigates to the active library tools page', () => {
    render(<UserMenu />);

    fireEvent.click(screen.getByRole('button', { name: /user menu/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));

    expect(mockNavigate).toHaveBeenCalledWith('/lib/library-1/tools');
  });
});
