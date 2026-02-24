import { z } from 'zod';

export const updateModelSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().nullable().optional(),
  previewImageFileId: z.string().uuid().nullable().optional(),
  previewCropX: z.number().min(0).max(100).nullable().optional(),
  previewCropY: z.number().min(0).max(100).nullable().optional(),
  previewCropScale: z.number().min(1).max(10).nullable().optional(),
});

export const bulkDeleteSchema = z.object({
  modelIds: z.array(z.string().uuid()).min(1),
});
