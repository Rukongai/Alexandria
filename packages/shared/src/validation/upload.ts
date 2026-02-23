import { z } from 'zod';

export const uploadInitSchema = z.object({
  filename: z.string().min(1).max(512),
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

export type UploadInitRequest = z.infer<typeof uploadInitSchema>;
export type ChunkIndexParams = z.infer<typeof chunkIndexParamsSchema>;
export type UploadCompleteParams = z.infer<typeof uploadCompleteParamsSchema>;
