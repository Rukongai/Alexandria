import { fireEvent, render, screen } from '@testing-library/react';
import type { ImageFile } from '@alexandria/shared';
import { describe, expect, it, vi } from 'vitest';
import { DisplayPreferencesProvider } from '../../hooks/use-display-preferences';
import { CoverCropModal } from './CoverCropModal';

const image: ImageFile = {
  id: 'image-1',
  filename: 'model.png',
  thumbnailUrl: '/files/model-detail.webp',
  originalUrl: '/files/model-original.png',
};

describe('CoverCropModal', () => {
  it('should use the detail thumbnail for the crop surface and live preview', () => {
    render(
      <DisplayPreferencesProvider>
        <CoverCropModal
          image={image}
          modelId="model-1"
          isCurrentCover={false}
          initialCropX={null}
          initialCropY={null}
          initialCropScale={null}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />
      </DisplayPreferencesProvider>,
    );

    const cropImage = screen.getByRole('img', { name: image.filename });
    expect(cropImage).toHaveAttribute('src', `/api${image.thumbnailUrl}`);
    expect(cropImage).toHaveAttribute('decoding', 'async');

    fireEvent.load(cropImage);

    const previewImage = screen.getByRole('img', { name: 'Card preview' });
    expect(previewImage).toHaveAttribute('src', `/api${image.thumbnailUrl}`);
    expect(previewImage).not.toHaveAttribute('src', `/api${image.originalUrl}`);
  });
});
