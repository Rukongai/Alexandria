import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TagIcon } from '../icons';
import { FacetItem } from './FacetItem';

describe('FacetItem', () => {
  it('renders the label', () => {
    render(<FacetItem label="miniature" />);
    expect(screen.getByText('miniature')).toBeTruthy();
  });

  it('renders the count when provided', () => {
    render(<FacetItem label="terrain" count={42} />);
    expect(screen.getByText('42')).toBeTruthy();
  });

  it('omits the count when not provided', () => {
    const { container } = render(<FacetItem label="terrain" />);
    // No count span — only label text exists
    expect(container.querySelectorAll('.ax-mono')).toHaveLength(0);
  });

  it('sets aria-pressed=true when active', () => {
    render(<FacetItem label="terrain" active={true} />);
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('sets aria-pressed=false when not active', () => {
    render(<FacetItem label="terrain" active={false} />);
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('calls onClick when clicked', () => {
    const onClick = vi.fn();
    render(<FacetItem label="terrain" onClick={onClick} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders the icon when provided', () => {
    const { container } = render(<FacetItem label="terrain" icon={TagIcon} />);
    // TagIcon renders an SVG
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('renders the expand chevron when hasChildren=true', () => {
    const { container } = render(
      <FacetItem label="Figurines" hasChildren={true} expanded={false} />
    );
    // ChevronRightIcon is an SVG
    const svgs = container.querySelectorAll('svg');
    expect(svgs.length).toBeGreaterThan(0);
  });

  it('calls onToggleExpand when the chevron span is clicked', () => {
    const onToggleExpand = vi.fn();
    const { container } = render(
      <FacetItem
        label="Figurines"
        hasChildren={true}
        expanded={false}
        onToggleExpand={onToggleExpand}
      />
    );
    // The chevron is the first child span of the button
    const chevronSpan = container.querySelector('button > span');
    expect(chevronSpan).toBeTruthy();
    fireEvent.click(chevronSpan!);
    expect(onToggleExpand).toHaveBeenCalledTimes(1);
  });
});
