import sharp from 'sharp';
import { THUMBNAIL_SIZES } from '@alexandria/shared';
import { storageService } from './storage.service.js';

export interface ThumbnailRecord {
  sourceFileId: string;
  storagePath: string;
  width: number;
  height: number;
  format: string;
}

export class ThumbnailService {
  async generateThumbnails(
    sourceFilePath: string,
    modelId: string,
    sourceFileId: string,
  ): Promise<ThumbnailRecord[]> {
    const sizes = [
      { key: 'grid', ...THUMBNAIL_SIZES.grid },
      { key: 'detail', ...THUMBNAIL_SIZES.detail },
    ] as const;

    // Each size is independent, so running them together overlaps one size's
    // upload with the other's resize instead of paying for them back to back.
    // Thumbnails are small enough that a remote store spends far longer on the
    // request round trip than on the transfer itself.
    return Promise.all(
      sizes.map(async (size): Promise<ThumbnailRecord> => {
        const storagePath = `thumbnails/${modelId}/${sourceFileId}_${size.key}.webp`;

        const { data, info } = await sharp(sourceFilePath)
          .resize({ width: size.width, height: size.height, fit: 'inside' })
          .webp()
          .toBuffer({ resolveWithObject: true });

        await storageService.store(storagePath, data);

        return {
          sourceFileId,
          storagePath,
          width: info.width,
          height: info.height,
          format: 'webp',
        };
      }),
    );
  }
}

export const thumbnailService = new ThumbnailService();
