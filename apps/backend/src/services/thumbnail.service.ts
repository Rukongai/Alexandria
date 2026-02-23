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
    const records: ThumbnailRecord[] = [];

    const sizes = [
      { key: 'grid', ...THUMBNAIL_SIZES.grid },
      { key: 'detail', ...THUMBNAIL_SIZES.detail },
    ] as const;

    for (const size of sizes) {
      const storagePath = `thumbnails/${modelId}/${sourceFileId}_${size.key}.webp`;

      const { data, info } = await sharp(sourceFilePath)
        .resize({ width: size.width, height: size.height, fit: 'inside' })
        .webp()
        .toBuffer({ resolveWithObject: true });

      await storageService.store(storagePath, data);

      records.push({
        sourceFileId,
        storagePath,
        width: info.width,
        height: info.height,
        format: 'webp',
      });
    }

    return records;
  }
}

export const thumbnailService = new ThumbnailService();
