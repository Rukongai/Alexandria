import { z } from 'zod';

export const importConfigSchema = z.object({
  sourcePath: z.string().min(1, 'Source path is required'),
  pattern: z.string().min(1, 'Pattern is required'),
  strategy: z.enum(['hardlink', 'copy', 'move']),
  deleteAfterUpload: z.boolean().optional(),
});
