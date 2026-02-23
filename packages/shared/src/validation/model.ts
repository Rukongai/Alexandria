import { z } from 'zod';

export const updateModelSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().nullable().optional(),
});

export const bulkDeleteSchema = z.object({
  modelIds: z.array(z.string().uuid()).min(1),
});
