import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AiChangePreview } from '@alexandria/shared';
import { ProposalPreviewCard } from './ProposalPreviewCard';

const proposal: AiChangePreview = {
  proposalId: '11111111-1111-4111-8111-111111111111',
  summary: 'Organize the dragon models',
  expiresAt: '2026-07-21T12:15:00.000Z',
  changes: [
    {
      type: 'update_model',
      modelId: '22222222-2222-4222-8222-222222222222',
      modelName: 'Red Dragon',
      patch: {
        name: 'Crimson Dragon',
        description: null,
        previewImageFileId: '33333333-3333-4333-8333-333333333333',
      },
    },
    {
      type: 'set_metadata',
      modelId: '44444444-4444-4444-8444-444444444444',
      modelName: 'Blue Dragon',
      values: {
        artist: 'Example Artist',
        tags: ['dragon', 'fantasy'],
        nsfw: false,
      },
    },
    {
      type: 'update_collections',
      modelId: '55555555-5555-4555-8555-555555555555',
      modelName: 'Green Dragon',
      addCollectionIds: ['66666666-6666-4666-8666-666666666666'],
      removeCollectionIds: ['77777777-7777-4777-8777-777777777777'],
    },
  ],
};

describe('ProposalPreviewCard', () => {
  it('should render every proposed action before explicit approval', () => {
    const onApply = vi.fn();

    render(
      <ProposalPreviewCard
        proposal={proposal}
        isApplying={false}
        isApplied={false}
        onApply={onApply}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByRole('region', { name: /preview: organize the dragon models/i })).toBeInTheDocument();
    expect(screen.getByText('Update Red Dragon')).toBeInTheDocument();
    expect(screen.getByText('name: Crimson Dragon')).toBeInTheDocument();
    expect(screen.getByText('description: Clear value')).toBeInTheDocument();
    expect(screen.getByText('Cover image: 33333333-3333-4333-8333-333333333333')).toBeInTheDocument();
    expect(screen.getByText('Set metadata on Blue Dragon')).toBeInTheDocument();
    expect(screen.getByText('artist: Example Artist')).toBeInTheDocument();
    expect(screen.getByText('tags: dragon, fantasy')).toBeInTheDocument();
    expect(screen.getByText('nsfw: No')).toBeInTheDocument();
    expect(screen.getByText('Update collections for Green Dragon')).toBeInTheDocument();
    expect(screen.getByText('Add to collection 66666666-6666-4666-8666-666666666666')).toBeInTheDocument();
    expect(screen.getByText('Remove from collection 77777777-7777-4777-8777-777777777777')).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('should call apply only when the user clicks the apply action', () => {
    const onApply = vi.fn();

    render(
      <ProposalPreviewCard
        proposal={proposal}
        isApplying={false}
        isApplied={false}
        onApply={onApply}
        onDismiss={vi.fn()}
      />,
    );

    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('should render server-resolved collection names and cover image details', () => {
    render(
      <ProposalPreviewCard
        proposal={{
          ...proposal,
          display: {
            collections: {
              '66666666-6666-4666-8666-666666666666': { name: 'Favorites' },
              '77777777-7777-4777-8777-777777777777': { name: 'Needs Review' },
            },
            images: {
              '33333333-3333-4333-8333-333333333333': {
                filename: 'dragon-hero.png',
                thumbnailUrl: '/files/thumbnails/dragon-hero.webp',
              },
            },
          },
        }}
        isApplying={false}
        isApplied={false}
        onApply={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText('Add to collection Favorites')).toBeInTheDocument();
    expect(screen.getByText('Remove from collection Needs Review')).toBeInTheDocument();
    expect(screen.getByText('Cover image: dragon-hero.png')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Proposed cover: dragon-hero.png' })).toHaveAttribute(
      'src',
      '/api/files/thumbnails/dragon-hero.webp',
    );
  });
});
