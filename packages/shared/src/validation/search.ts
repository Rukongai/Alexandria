import { z } from 'zod';

export const modelSearchParamsSchema = z.object({
  q: z.string().trim().max(500).optional(),

  tags: z.string().optional().refine(
    (val) => {
      if (val === undefined) return true;
      return val.split(',').every((name) => name.trim().length > 0);
    },
    { message: 'tags must be a comma-separated list of non-empty tag names' },
  ),

  collectionId: z.string().uuid().optional(),

  fileType: z.enum(['stl', 'image', 'document', 'other']).optional(),

  status: z.enum(['processing', 'ready', 'error']).optional(),

  sort: z.enum(['name', 'createdAt', 'totalSizeBytes']).optional(),

  sortDir: z.enum(['asc', 'desc']).optional(),

  cursor: z.string().optional(),

  pageSize: z.coerce.number().int().min(1).max(200).default(50),

  metadataFilters: z.record(z.string(), z.string()).optional(),
});
