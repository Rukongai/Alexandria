import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ModelCard as ModelCardType } from '@alexandria/shared';
import { describe, expect, it } from 'vitest';
import { DisplayPreferencesProvider } from '../../hooks/use-display-preferences';
import { ModelCard } from './ModelCard';

function makeModel(isDuplicate: boolean): ModelCardType {
  return {
    id: isDuplicate ? 'duplicate-model' : 'regular-model',
    name: isDuplicate ? 'Duplicate Dragon' : 'Original Dragon',
    slug: isDuplicate ? 'duplicate-dragon' : 'original-dragon',
    thumbnailUrl: null,
    previewCropX: null,
    previewCropY: null,
    previewCropScale: null,
    metadata: [],
    fileCount: 1,
    totalSizeBytes: 100,
    status: 'ready',
    isDuplicate,
    createdAt: '2025-01-01T00:00:00.000Z',
  };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter>
      <DisplayPreferencesProvider>{children}</DisplayPreferencesProvider>
    </MemoryRouter>
  );
}

describe('ModelCard', () => {
  it('shows the duplicate badge only for marked models', () => {
    const { rerender } = render(<ModelCard model={makeModel(true)} />, { wrapper });

    expect(screen.getByText('Duplicate')).toBeInTheDocument();

    rerender(<ModelCard model={makeModel(false)} />);

    expect(screen.queryByText('Duplicate')).not.toBeInTheDocument();
  });
});
