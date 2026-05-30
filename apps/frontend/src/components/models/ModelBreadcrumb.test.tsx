import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { CollectionSummary } from '@alexandria/shared';
import { ModelBreadcrumb } from './ModelBreadcrumb';

function renderBreadcrumb(props: {
  collection: CollectionSummary | null;
  modelName: string;
}) {
  return render(
    <MemoryRouter>
      <ModelBreadcrumb {...props} />
    </MemoryRouter>,
  );
}

describe('ModelBreadcrumb', () => {
  it('renders Library and the model name when there is no collection', () => {
    renderBreadcrumb({ collection: null, modelName: 'Ancient Wyrm' });

    const nav = screen.getByRole('navigation', { name: 'Model breadcrumb' });
    expect(nav).toBeInTheDocument();
    expect(screen.getByText('Library')).toBeInTheDocument();
    expect(screen.getByText('Ancient Wyrm')).toBeInTheDocument();
    // No collection crumb
    expect(screen.queryByText('Dragons')).not.toBeInTheDocument();
  });

  it('renders a linked collection crumb when present', () => {
    renderBreadcrumb({
      collection: { id: 'col-1', name: 'Dragons', slug: 'dragons' },
      modelName: 'Ancient Wyrm',
    });

    const collectionLink = screen.getByRole('link', { name: 'Dragons' });
    expect(collectionLink).toHaveAttribute('href', '/collections/col-1');
  });

  it('links Library to the home route', () => {
    renderBreadcrumb({ collection: null, modelName: 'Ancient Wyrm' });
    expect(screen.getByRole('link', { name: 'Library' })).toHaveAttribute(
      'href',
      '/',
    );
  });

  it('renders the model name as the current page, not a link', () => {
    renderBreadcrumb({
      collection: { id: 'col-1', name: 'Dragons', slug: 'dragons' },
      modelName: 'Ancient Wyrm',
    });

    const current = screen.getByText('Ancient Wyrm');
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(
      screen.queryByRole('link', { name: 'Ancient Wyrm' }),
    ).not.toBeInTheDocument();
  });
});
