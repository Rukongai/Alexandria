import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ImageFile } from '@alexandria/shared';
import { describe, expect, it, vi } from 'vitest';
import { ImageGallery } from './ImageGallery';

const image: ImageFile = {
  id: 'image-1',
  filename: 'model.png',
  thumbnailUrl: '/files/model-detail.webp',
  originalUrl: '/files/model-original.png',
};

function renderGallery() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ImageGallery
        images={[image]}
        previewImageFileId={null}
        previewCropX={null}
        previewCropY={null}
        previewCropScale={null}
        modelId="model-1"
        selectedImageFileId={image.id}
        onSelectImage={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe('ImageGallery', () => {
  it('should use the detail thumbnail for the hero and the original for the lightbox', () => {
    renderGallery();

    const hero = screen.getByRole('img', { name: image.filename });
    expect(hero).toHaveAttribute('src', `/api${image.thumbnailUrl}`);
    expect(hero).toHaveAttribute('loading', 'eager');
    expect(hero).toHaveAttribute('decoding', 'async');

    fireEvent.click(hero);

    const renderedImages = screen.getAllByRole('img', { name: image.filename });
    expect(renderedImages).toHaveLength(2);
    expect(renderedImages[0]).toHaveAttribute('src', `/api${image.thumbnailUrl}`);
    expect(renderedImages[1]).toHaveAttribute('src', `/api${image.originalUrl}`);
  });
});
