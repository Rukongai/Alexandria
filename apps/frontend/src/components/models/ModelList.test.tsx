import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ModelCard } from '@alexandria/shared';
import { ModelList } from './ModelList';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const makeModel = (overrides: Partial<ModelCard> = {}): ModelCard => ({
  id: 'model-1',
  name: 'Benchy',
  slug: 'benchy',
  thumbnailUrl: '/thumbnails/benchy.webp',
  previewCropX: null,
  previewCropY: null,
  previewCropScale: null,
  metadata: [
    {
      fieldSlug: 'artist',
      fieldName: 'Artist',
      type: 'text',
      value: 'Maker A',
      displayValue: 'Maker A',
    },
    {
      fieldSlug: 'tags',
      fieldName: 'Tags',
      type: 'multi_enum',
      value: ['fdm', 'functional'],
      displayValue: 'fdm, functional',
    },
  ],
  fileCount: 3,
  totalSizeBytes: 1024 * 1024,
  status: 'ready',
  createdAt: '2024-01-01',
  ...overrides,
});

const MODELS: ModelCard[] = [
  makeModel({ id: 'model-1', name: 'Benchy' }),
  makeModel({ id: 'model-2', name: 'Voronoi Vase', thumbnailUrl: null, metadata: [] }),
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function wrapper({ children }: { children: React.ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('ModelList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a row for each model', () => {
    render(<ModelList models={MODELS} />, { wrapper });

    expect(screen.getByText('Benchy')).toBeTruthy();
    expect(screen.getByText('Voronoi Vase')).toBeTruthy();
  });

  it('renders column headers', () => {
    render(<ModelList models={MODELS} />, { wrapper });

    expect(screen.getByText('Name')).toBeTruthy();
    expect(screen.getByText('Artist')).toBeTruthy();
    expect(screen.getByText('Tags')).toBeTruthy();
  });

  it('shows artist metadata when present', () => {
    render(<ModelList models={[makeModel()]} />, { wrapper });

    expect(screen.getByText('Maker A')).toBeTruthy();
  });

  it('shows tags for models that have them', () => {
    render(<ModelList models={[makeModel()]} />, { wrapper });

    expect(screen.getByText('fdm')).toBeTruthy();
    expect(screen.getByText('functional')).toBeTruthy();
  });

  it('renders a thumbnail img when showThumbnails=true (default)', () => {
    const { container } = render(<ModelList models={[makeModel()]} />, { wrapper });

    // The thumbnail img uses alt="" (decorative), so it is presentation role.
    // Query it by tag name to confirm it is rendered.
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
  });

  it('does not render a thumbnail img when showThumbnails=false', () => {
    const { container } = render(<ModelList models={[makeModel()]} showThumbnails={false} />, { wrapper });

    expect(container.querySelector('img')).toBeNull();
  });

  it('fires onToggleSelect when selectable and row is clicked', () => {
    const onToggleSelect = vi.fn();
    render(
      <ModelList
        models={[makeModel()]}
        selectable
        isSelected={() => false}
        onToggleSelect={onToggleSelect}
      />,
      { wrapper }
    );

    const rows = screen.getAllByRole('row');
    // First row is the header (aria-hidden), second is the model row
    const modelRow = rows.find((r) => r.getAttribute('aria-selected') !== null);
    expect(modelRow).toBeTruthy();
    fireEvent.click(modelRow!);
    expect(onToggleSelect).toHaveBeenCalledWith('model-1');
  });

  it('fires onToggleSelect on Enter key when selectable', () => {
    const onToggleSelect = vi.fn();
    render(
      <ModelList
        models={[makeModel()]}
        selectable
        isSelected={() => false}
        onToggleSelect={onToggleSelect}
      />,
      { wrapper }
    );

    const modelRow = screen.getByRole('row', { name: /select model: benchy/i });
    fireEvent.keyDown(modelRow, { key: 'Enter' });
    expect(onToggleSelect).toHaveBeenCalledWith('model-1');
  });

  it('marks row as selected when isSelected returns true', () => {
    render(
      <ModelList
        models={[makeModel()]}
        selectable
        isSelected={() => true}
        onToggleSelect={() => {}}
      />,
      { wrapper }
    );

    const modelRow = screen.getByRole('row', { name: /deselect model: benchy/i });
    expect(modelRow.getAttribute('aria-selected')).toBe('true');
  });

  it('renders without crashing when models array is empty', () => {
    const { container } = render(<ModelList models={[]} />, { wrapper });
    expect(container).toBeTruthy();
  });
});
