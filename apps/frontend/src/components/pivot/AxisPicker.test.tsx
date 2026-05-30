import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AxisPicker } from './AxisPicker';

function makeWrapper(initialUrl = '/') {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <MemoryRouter initialEntries={[initialUrl]}>{children}</MemoryRouter>;
  };
}

describe('AxisPicker', () => {
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
});
