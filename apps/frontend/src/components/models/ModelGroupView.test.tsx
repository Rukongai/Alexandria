import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ModelCard } from '@alexandria/shared';
import { ModelGroupView } from './ModelGroupView';
import { DisplayPreferencesProvider } from '../../hooks/use-display-preferences';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function makeModel(overrides: Partial<ModelCard> = {}): ModelCard {
  return {
    id: 'model-1',
    name: 'Benchy',
    slug: 'benchy',
    thumbnailUrl: null,
    previewCropX: null,
    previewCropY: null,
    previewCropScale: null,
    metadata: [],
    fileCount: 1,
    totalSizeBytes: 1000,
    status: 'ready',
    createdAt: '2024-01-01',
    ...overrides,
  };
}

const MODEL_TAGS_DUAL = makeModel({
  id: 'model-dual',
  name: 'Dragon Bust',
  metadata: [
    { fieldSlug: 'tags', fieldName: 'Tags', type: 'multi_enum', value: ['fantasy', 'dragons'], displayValue: 'fantasy, dragons' },
  ],
});

const MODEL_TAGS_SINGLE = makeModel({
  id: 'model-single',
  name: 'Voronoi Vase',
  metadata: [
    { fieldSlug: 'tags', fieldName: 'Tags', type: 'multi_enum', value: ['functional'], displayValue: 'functional' },
  ],
});

const MODEL_UNTAGGED = makeModel({
  id: 'model-untagged',
  name: 'No Tags Model',
  metadata: [],
});

const MODEL_ARTIST_A = makeModel({
  id: 'model-artist-a',
  name: 'Robot Arm',
  metadata: [
    { fieldSlug: 'artist', fieldName: 'Artist', type: 'text', value: 'Alice', displayValue: 'Alice' },
  ],
});

const MODEL_ARTIST_B = makeModel({
  id: 'model-artist-b',
  name: 'Gear Box',
  metadata: [
    { fieldSlug: 'artist', fieldName: 'Artist', type: 'text', value: 'Bob', displayValue: 'Bob' },
  ],
});

const MODEL_NO_ARTIST = makeModel({
  id: 'model-no-artist',
  name: 'Mystery Print',
  metadata: [],
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter>
      <DisplayPreferencesProvider>{children}</DisplayPreferencesProvider>
    </MemoryRouter>
  );
}

const DEFAULT_AXIS_VALUE = { collectionId: undefined, artist: undefined, tags: [] };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('ModelGroupView', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  // ── axis='tags' ───────────────────────────────────────────────────────────
  describe('axis=tags', () => {
    it('renders a model with two tags under both tag headers', () => {
      render(
        <ModelGroupView
          models={[MODEL_TAGS_DUAL]}
          axis="tags"
          activeAxisValue={DEFAULT_AXIS_VALUE}
        />,
        { wrapper }
      );

      // Both headers should appear
      expect(screen.getByRole('heading', { name: /fantasy/i })).toBeTruthy();
      expect(screen.getByRole('heading', { name: /dragons/i })).toBeTruthy();

      // The model name appears twice (once in each group)
      const names = screen.getAllByText('Dragon Bust');
      expect(names.length).toBe(2);
    });

    it('renders an untagged model under the Untagged header', () => {
      render(
        <ModelGroupView
          models={[MODEL_UNTAGGED]}
          axis="tags"
          activeAxisValue={DEFAULT_AXIS_VALUE}
        />,
        { wrapper }
      );

      expect(screen.getByRole('heading', { name: /untagged/i })).toBeTruthy();
      expect(screen.getByText('No Tags Model')).toBeTruthy();
    });

    it('groups different models under their respective tag headers', () => {
      render(
        <ModelGroupView
          models={[MODEL_TAGS_DUAL, MODEL_TAGS_SINGLE, MODEL_UNTAGGED]}
          axis="tags"
          activeAxisValue={DEFAULT_AXIS_VALUE}
        />,
        { wrapper }
      );

      expect(screen.getByRole('heading', { name: /fantasy/i })).toBeTruthy();
      expect(screen.getByRole('heading', { name: /dragons/i })).toBeTruthy();
      expect(screen.getByRole('heading', { name: /functional/i })).toBeTruthy();
      expect(screen.getByRole('heading', { name: /untagged/i })).toBeTruthy();
    });

    it('shows the loaded count next to each group header', () => {
      render(
        <ModelGroupView
          models={[MODEL_TAGS_DUAL, MODEL_TAGS_SINGLE]}
          axis="tags"
          activeAxisValue={DEFAULT_AXIS_VALUE}
        />,
        { wrapper }
      );

      // Each single-model group shows count of 1
      const ones = screen.getAllByText('1');
      expect(ones.length).toBeGreaterThanOrEqual(3); // fantasy:1, dragons:1, functional:1
    });
  });

  // ── axis='artists' ────────────────────────────────────────────────────────
  describe('axis=artists', () => {
    it('groups models by artist', () => {
      render(
        <ModelGroupView
          models={[MODEL_ARTIST_A, MODEL_ARTIST_B]}
          axis="artists"
          activeAxisValue={DEFAULT_AXIS_VALUE}
        />,
        { wrapper }
      );

      expect(screen.getByRole('heading', { name: /alice/i })).toBeTruthy();
      expect(screen.getByRole('heading', { name: /bob/i })).toBeTruthy();
      expect(screen.getByText('Robot Arm')).toBeTruthy();
      expect(screen.getByText('Gear Box')).toBeTruthy();
    });

    it('places models without an artist in the "Unknown artist" group', () => {
      render(
        <ModelGroupView
          models={[MODEL_NO_ARTIST]}
          axis="artists"
          activeAxisValue={DEFAULT_AXIS_VALUE}
        />,
        { wrapper }
      );

      expect(screen.getByRole('heading', { name: /unknown artist/i })).toBeTruthy();
      expect(screen.getByText('Mystery Print')).toBeTruthy();
    });

    it('each model appears in exactly one group', () => {
      render(
        <ModelGroupView
          models={[MODEL_ARTIST_A, MODEL_NO_ARTIST]}
          axis="artists"
          activeAxisValue={DEFAULT_AXIS_VALUE}
        />,
        { wrapper }
      );

      expect(screen.getAllByText('Robot Arm').length).toBe(1);
      expect(screen.getAllByText('Mystery Print').length).toBe(1);
    });
  });

  // ── axis='collections' ────────────────────────────────────────────────────
  describe('axis=collections', () => {
    it('renders a single group containing all models', () => {
      const models = [MODEL_ARTIST_A, MODEL_ARTIST_B, MODEL_UNTAGGED];
      render(
        <ModelGroupView
          models={models}
          axis="collections"
          activeAxisValue={DEFAULT_AXIS_VALUE}
        />,
        { wrapper }
      );

      // Only one h2 (group header) rendered — ModelCard uses h3 for model names,
      // so we narrow to h2 to distinguish group headers from card titles.
      const groupHeaders = screen.getAllByRole('heading', { level: 2 });
      expect(groupHeaders.length).toBe(1);

      // All models appear
      expect(screen.getByText('Robot Arm')).toBeTruthy();
      expect(screen.getByText('Gear Box')).toBeTruthy();
      expect(screen.getByText('No Tags Model')).toBeTruthy();
    });

    it('labels the single group "All models" when no collection is selected', () => {
      render(
        <ModelGroupView
          models={[MODEL_ARTIST_A]}
          axis="collections"
          activeAxisValue={DEFAULT_AXIS_VALUE}
        />,
        { wrapper }
      );

      expect(screen.getByRole('heading', { name: /all models/i })).toBeTruthy();
    });

    it('labels the single group "Collection" when a collectionId is active', () => {
      render(
        <ModelGroupView
          models={[MODEL_ARTIST_A]}
          axis="collections"
          activeAxisValue={{ ...DEFAULT_AXIS_VALUE, collectionId: 'col-123' }}
        />,
        { wrapper }
      );

      expect(screen.getByRole('heading', { name: /collection/i })).toBeTruthy();
    });
  });
});
