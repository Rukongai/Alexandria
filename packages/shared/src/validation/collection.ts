import { z } from 'zod';

export const createCollectionSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  parentCollectionId: z.string().uuid().optional(),
});

export const updateCollectionSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
  parentCollectionId: z.string().uuid().nullable().optional(),
});

export const addModelsToCollectionSchema = z.object({
  modelIds: z.array(z.string().uuid()).min(1),
});

export const bulkCollectionSchema = z.object({
  modelIds: z.array(z.string().uuid()).min(1),
  action: z.enum(['add', 'remove']),
  collectionId: z.string().uuid(),
});

export const collectionListParamsSchema = z.object({
  depth: z.coerce.number().int().min(1).max(10).optional(),
});
