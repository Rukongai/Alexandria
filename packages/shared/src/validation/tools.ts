import { z } from 'zod';

export const duplicateFileGroupParamsSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/, 'Hash must be a lowercase SHA-256 digest'),
});

export type DuplicateFileGroupParams = z.infer<typeof duplicateFileGroupParamsSchema>;
