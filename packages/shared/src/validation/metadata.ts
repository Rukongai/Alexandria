import { z } from 'zod';

const metadataFieldTypeSchema = z.enum([
  'text',
  'number',
  'boolean',
  'date',
  'url',
  'enum',
  'multi_enum',
]);

const metadataFieldConfigSchema = z.object({
  enumOptions: z.array(z.string()).optional(),
  validationPattern: z.string().optional(),
  displayHint: z.string().optional(),
});

export const createMetadataFieldSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  type: metadataFieldTypeSchema,
  isFilterable: z.boolean().optional(),
  isBrowsable: z.boolean().optional(),
  config: metadataFieldConfigSchema.optional(),
});

export const updateMetadataFieldSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  isFilterable: z.boolean().optional(),
  isBrowsable: z.boolean().optional(),
  config: metadataFieldConfigSchema.optional(),
});

export const setModelMetadataSchema = z.record(
  z.string(),
  z.union([
    z.string(),
    z.array(z.string()),
    z.number(),
    z.boolean(),
    z.null(),
  ]),
);

const bulkMetadataOperationSchema = z.object({
  fieldSlug: z.string().min(1),
  action: z.enum(['set', 'remove']),
  value: z.union([
    z.string(),
    z.array(z.string()),
    z.number(),
    z.boolean(),
  ]).optional(),
});

export const bulkMetadataSchema = z.object({
  modelIds: z.array(z.string().uuid()).min(1, 'At least one model ID is required'),
  operations: z.array(bulkMetadataOperationSchema).min(1, 'At least one operation is required'),
});
