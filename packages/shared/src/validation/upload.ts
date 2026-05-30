import { z } from 'zod';
import { SUPPORTED_ARCHIVE_EXTENSIONS } from '../constants/index.js';

export const uploadInitSchema = z.object({
  filename: z.string().min(1).max(512).refine(
    (f) => {
      const lower = f.toLowerCase();
      return SUPPORTED_ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
    },
    { message: 'File must be a supported archive format (.zip, .rar, .7z, .tar.gz)' },
  ),
  totalSize: z.number().int().positive().max(5 * 1024 * 1024 * 1024), // 5GB
  totalChunks: z.number().int().positive().max(1000),
});

export const chunkIndexParamsSchema = z.object({
  uploadId: z.string().uuid(),
  index: z.coerce.number().int().min(0),
});

export const uploadCompleteParamsSchema = z.object({
  uploadId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Staged upload: review/commit
// ---------------------------------------------------------------------------

export const uploadOptionsSchema = z.object({
  markPreSupported: z.boolean().optional(),
  autoThumbnails: z.boolean().optional(),
  markNsfw: z.boolean().optional(),
  skipDuplicatesByHash: z.boolean().optional(),
});

export const batchUploadMetadataSchema = z.object({
  collectionId: z.string().uuid().optional(),
  newCollectionName: z.string().min(1).max(255).optional(),
  artist: z.string().max(255).optional(),
  tags: z.array(z.string().min(1).max(100)).max(50).optional(),
  options: uploadOptionsSchema.optional(),
});

export const commitImportSessionSchema = z.object({
  batchMetadata: batchUploadMetadataSchema.optional(),
});

export const importSessionIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export type UploadInitRequest = z.infer<typeof uploadInitSchema>;
export type ChunkIndexParams = z.infer<typeof chunkIndexParamsSchema>;
export type UploadCompleteParams = z.infer<typeof uploadCompleteParamsSchema>;
