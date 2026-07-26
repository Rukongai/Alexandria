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

  it('renders staged-upload metadata and a resolved destination collection', () => {
    render(
      <ProposalPreviewCard
        proposal={{
          proposalId: '88888888-8888-4888-8888-888888888888',
          summary: 'Fill upload metadata',
          expiresAt: '2026-07-21T12:15:00.000Z',
          display: {
            collections: {
              '99999999-9999-4999-8999-999999999999': { name: 'Anime' },
            },
            images: {},
          },
          changes: [{
            type: 'update_import_session',
            importSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            originalFilename: 'Artist - 2024 - Lust.zip',
            expectedUpdatedAt: '2026-07-21T12:00:00.000Z',
            patch: {
              modelName: 'Lust',
              artist: 'Artist',
              collectionId: '99999999-9999-4999-8999-999999999999',
              metadata: { source: 'Fullmetal Alchemist', year: 2024 },
              options: { markPreSupported: true, markNsfw: false },
            },
          }],
        }}
        isApplying={false}
        isApplied={false}
        onApply={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText('Update upload Artist - 2024 - Lust.zip')).toBeVisible();
    expect(screen.getByText('modelName: Lust')).toBeVisible();
    expect(screen.getByText('source: Fullmetal Alchemist')).toBeVisible();
    expect(screen.getByText('year: 2024')).toBeVisible();
    expect(screen.getByText('Collection: Anime')).toBeVisible();
    expect(screen.getByText('markPreSupported: Yes')).toBeVisible();
    expect(screen.getByText('markNsfw: No')).toBeVisible();
  });

  it('should render a human-readable staged-upload file organization', () => {
    const importSessionId = 'abababab-abab-4bab-8bab-abababababab';

    render(
      <ProposalPreviewCard
        proposal={{
          proposalId: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
          summary: 'Organize the staged dragon upload',
          expiresAt: '2026-07-21T12:15:00.000Z',
          display: {
            collections: {},
            images: {},
            importSessionLayouts: {
              [importSessionId]: {
                fileCount: 27,
                sampleDestinationPaths: [
                  'Images/Renders/NSFW/front.png',
                  'Model/Standard/body.stl',
                ],
              },
            },
          },
          changes: [{
            type: 'organize_import_session_files',
            importSessionId,
            originalFilename: 'Artist - 2026-07 - Dragon.zip',
            expectedUpdatedAt: '2026-07-21T12:00:00.000Z',
            layout: {
              rootFolders: ['Model', 'Images'],
              prefixMappings: [
                { sourcePrefix: 'Renders', destinationPrefix: 'Images/Renders' },
                { sourcePrefix: 'Standard', destinationPrefix: 'Model/Standard' },
              ],
              fileMappings: [{
                sourcePath: 'loose/body.stl',
                destinationPath: 'Model/Standard/body.stl',
              }],
            },
          }],
        }}
        isApplying={false}
        isApplied={false}
        onApply={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText('Organize upload Artist - 2026-07 - Dragon.zip')).toBeVisible();
    expect(screen.getByText('Create root folders: Model and Images')).toBeVisible();
    expect(screen.getByText('Move Renders → Images/Renders')).toBeVisible();
    expect(screen.getByText('Move Standard → Model/Standard')).toBeVisible();
    expect(screen.getByText('Move file loose/body.stl → Model/Standard/body.stl')).toBeVisible();
    expect(screen.getByText('27 files will be organized')).toBeVisible();
    expect(screen.getByText('Sample destinations')).toBeVisible();
    expect(screen.getByText('Images/Renders/NSFW/front.png')).toBeVisible();
    expect(screen.getByText('Model/Standard/body.stl')).toBeVisible();
  });

  it('should summarize bulk metadata operations without rendering frozen model IDs', () => {
    const modelIds = Array.from(
      { length: 1000 },
      (_, index) => `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    );

    render(
      <ProposalPreviewCard
        proposal={{
          proposalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          summary: 'Standardize the library metadata',
          expiresAt: '2026-07-21T12:15:00.000Z',
          changes: [{
            type: 'bulk_metadata',
            modelIds,
            operations: [
              { fieldSlug: 'tags', action: 'add', value: ['terrain', 'fantasy'] },
              { fieldSlug: 'print_quality', action: 'set', value: 'High' },
              { fieldSlug: 'artist', action: 'remove' },
            ],
          }],
        }}
        isApplying={false}
        isApplied={false}
        onApply={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText('Update metadata on 1,000 models')).toBeVisible();
    expect(screen.getByText('Add terrain, fantasy to Tags')).toBeVisible();
    expect(screen.getByText('Set Print quality to High')).toBeVisible();
    expect(screen.getByText('Clear Artist')).toBeVisible();
    const preview = screen.getByRole('region', { name: /preview: standardize the library metadata/i });
    expect(preview).not.toHaveTextContent(modelIds[0]);
    expect(preview).not.toHaveTextContent(modelIds[999]);
  });

  it('should summarize bulk collection changes with server-resolved names', () => {
    const modelIds = [
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    ];
    const favoritesId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const reviewId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

    render(
      <ProposalPreviewCard
        proposal={{
          proposalId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          summary: 'Reorganize selected models',
          expiresAt: '2026-07-21T12:15:00.000Z',
          display: {
            collections: {
              [favoritesId]: { name: 'Favorites' },
              [reviewId]: { name: 'Needs Review' },
            },
            images: {},
            bulkTarget: {
              scope: 'current_models',
              modelCount: 2,
              sampleModelNames: ['Red Dragon', 'Blue Dragon'],
            },
          },
          changes: [{
            type: 'bulk_collections',
            modelIds,
            operations: [
              { collectionId: favoritesId, action: 'add' },
              { collectionId: reviewId, action: 'remove' },
            ],
          }],
        }}
        isApplying={false}
        isApplied={false}
        onApply={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText('Update collections')).toBeVisible();
    expect(screen.getByText('Selected models')).toBeVisible();
    expect(screen.getByText('2 models affected')).toBeVisible();
    expect(screen.getByText('Red Dragon, Blue Dragon')).toBeVisible();
    expect(screen.getByText('Add to collection Favorites')).toBeVisible();
    expect(screen.getByText('Remove from collection Needs Review')).toBeVisible();
    const preview = screen.getByRole('region', { name: /preview: reorganize selected models/i });
    expect(preview).not.toHaveTextContent(modelIds[0]);
    expect(preview).not.toHaveTextContent(modelIds[1]);
  });

  it('should bound the model-name sample for an active-library bulk proposal', () => {
    const modelIds = Array.from(
      { length: 1000 },
      (_, index) => `ffffffff-ffff-4fff-8fff-${index.toString().padStart(12, '0')}`,
    );

    render(
      <ProposalPreviewCard
        proposal={{
          proposalId: '12121212-1212-4212-8212-121212121212',
          summary: 'Tag the entire library',
          expiresAt: '2026-07-21T12:15:00.000Z',
          display: {
            collections: {},
            images: {},
            bulkTarget: {
              scope: 'active_library',
              modelCount: 1000,
              sampleModelNames: [
                'Red Dragon',
                'Blue Dragon',
                'Green Dragon',
                'Gold Dragon',
                'Silver Dragon',
                'Hidden Dragon',
                'Another Hidden Dragon',
              ],
            },
          },
          changes: [{
            type: 'bulk_metadata',
            modelIds,
            operations: [{ fieldSlug: 'tags', action: 'add', value: 'library-wide' }],
          }],
        }}
        isApplying={false}
        isApplied={false}
        onApply={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText('Update metadata')).toBeVisible();
    expect(screen.getByText('Entire active library')).toBeVisible();
    expect(screen.getByText('1,000 models affected')).toBeVisible();
    expect(screen.getByText(
      'Red Dragon, Blue Dragon, Green Dragon, Gold Dragon, Silver Dragon',
    )).toBeVisible();
    expect(screen.getByText('995 more')).toBeVisible();
    expect(screen.queryByText('Hidden Dragon')).not.toBeInTheDocument();
    expect(screen.queryByText('Another Hidden Dragon')).not.toBeInTheDocument();
    const preview = screen.getByRole('region', { name: /preview: tag the entire library/i });
    expect(preview).not.toHaveTextContent(modelIds[0]);
    expect(preview).not.toHaveTextContent(modelIds[999]);
  });
});
