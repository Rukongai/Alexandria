import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DisplayPreferencesProvider } from '../../hooks/use-display-preferences';
import { ViewSwitch } from './ViewSwitch';

function wrapper({ children }: { children: React.ReactNode }) {
  return <DisplayPreferencesProvider>{children}</DisplayPreferencesProvider>;
}

describe('ViewSwitch', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders all three view buttons', () => {
    render(<ViewSwitch />, { wrapper });

    expect(screen.getByRole('button', { name: /grid view/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /list view/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /group view/i })).toBeTruthy();
  });

  it('marks grid as active by default (aria-pressed=true)', () => {
    render(<ViewSwitch />, { wrapper });

    expect(screen.getByRole('button', { name: /grid view/i }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /list view/i }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: /group view/i }).getAttribute('aria-pressed')).toBe('false');
  });

  it('clicking List view makes it active', () => {
    render(<ViewSwitch />, { wrapper });

    const listBtn = screen.getByRole('button', { name: /list view/i });
    const gridBtn = screen.getByRole('button', { name: /grid view/i });

    fireEvent.click(listBtn);

    expect(listBtn.getAttribute('aria-pressed')).toBe('true');
    expect(gridBtn.getAttribute('aria-pressed')).toBe('false');
  });

  it('clicking Group view makes it active', () => {
    render(<ViewSwitch />, { wrapper });

    const groupBtn = screen.getByRole('button', { name: /group view/i });

    fireEvent.click(groupBtn);

    expect(groupBtn.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /grid view/i }).getAttribute('aria-pressed')).toBe('false');
  });

  it('clicking Grid after another view restores grid as active', () => {
    render(<ViewSwitch />, { wrapper });

    const gridBtn = screen.getByRole('button', { name: /grid view/i });
    const listBtn = screen.getByRole('button', { name: /list view/i });

    fireEvent.click(listBtn);
    expect(listBtn.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(gridBtn);
    expect(gridBtn.getAttribute('aria-pressed')).toBe('true');
    expect(listBtn.getAttribute('aria-pressed')).toBe('false');
  });
});
