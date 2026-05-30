import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Breadcrumb } from './Breadcrumb';
import type { ActiveAxisValue } from '../../hooks/use-model-filters';

const EMPTY_AXIS_VALUE: ActiveAxisValue = {
  collectionId: undefined,
  artist: undefined,
  tags: [],
  smartCollectionId: undefined,
};

describe('Breadcrumb', () => {
  it('always renders Library as the first crumb', () => {
    render(<Breadcrumb axis="collections" activeAxisValue={EMPTY_AXIS_VALUE} />);

    expect(screen.getByText('Library')).toBeTruthy();
  });

  it('renders "Collections" axis label for collections axis', () => {
    render(<Breadcrumb axis="collections" activeAxisValue={EMPTY_AXIS_VALUE} />);

    expect(screen.getByText('Collections')).toBeTruthy();
  });

  it('renders "Artists" axis label for artists axis', () => {
    render(<Breadcrumb axis="artists" activeAxisValue={EMPTY_AXIS_VALUE} />);

    expect(screen.getByText('Artists')).toBeTruthy();
  });

  it('renders "Tags" axis label for tags axis', () => {
    render(<Breadcrumb axis="tags" activeAxisValue={EMPTY_AXIS_VALUE} />);

    expect(screen.getByText('Tags')).toBeTruthy();
  });

  it('renders a collection crumb when collectionId is set', () => {
    const value: ActiveAxisValue = {
      ...EMPTY_AXIS_VALUE,
      collectionId: 'col-123',
    };
    render(<Breadcrumb axis="collections" activeAxisValue={value} />);

    expect(screen.getByText('Collection')).toBeTruthy();
  });

  it('renders the artist name crumb when artist is set', () => {
    const value: ActiveAxisValue = {
      ...EMPTY_AXIS_VALUE,
      artist: 'MZ4250',
    };
    render(<Breadcrumb axis="artists" activeAxisValue={value} />);

    expect(screen.getByText('MZ4250')).toBeTruthy();
  });

  it('renders tag names joined when tags are set', () => {
    const value: ActiveAxisValue = {
      ...EMPTY_AXIS_VALUE,
      tags: ['dragon', 'fantasy'],
    };
    render(<Breadcrumb axis="tags" activeAxisValue={value} />);

    expect(screen.getByText('dragon, fantasy')).toBeTruthy();
  });

  it('does not render a value crumb when nothing is selected', () => {
    render(<Breadcrumb axis="collections" activeAxisValue={EMPTY_AXIS_VALUE} />);

    // Only "Library" and "Collections" — no third crumb
    expect(screen.queryByText('Collection')).toBeNull();
  });

  it('has nav element with correct aria-label', () => {
    render(<Breadcrumb axis="collections" activeAxisValue={EMPTY_AXIS_VALUE} />);

    const nav = screen.getByRole('navigation', { name: /pivot breadcrumb/i });
    expect(nav).toBeTruthy();
  });
});
