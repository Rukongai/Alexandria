import { z } from 'zod';

export const duplicateFileGroupParamsSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/, 'Hash must be a lowercase SHA-256 digest'),
});

export type DuplicateFileGroupParams = z.infer<typeof duplicateFileGroupParamsSchema>;

export const consolidateDuplicateModelsSchema = z.object({
  sourceModelId: z.string().uuid(),
  targetModelId: z.string().uuid(),
}).refine((value) => value.sourceModelId !== value.targetModelId, {
  message: 'Source and target models must be different',
  path: ['sourceModelId'],
});

export type ConsolidateDuplicateModelsRequest = z.infer<typeof consolidateDuplicateModelsSchema>;
