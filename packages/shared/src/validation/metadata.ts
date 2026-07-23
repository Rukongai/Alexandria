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
  enumOptions: z.array(z.string().max(10_000)).max(100).optional(),
  validationPattern: z.string().max(512).optional(),
  displayHint: z.string().max(255).optional(),
});

const metadataStringSchema = z.string().max(10_000);
const nonNullMetadataValueSchema = z.union([
  metadataStringSchema,
  z.array(metadataStringSchema).max(100),
  z.number().finite(),
  z.boolean(),
]);
const metadataValueSchema = z.union([nonNullMetadataValueSchema, z.null()]);

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
  z.string().min(1).max(255),
  metadataValueSchema,
);

const bulkMetadataOperationSchema = z.object({
  fieldSlug: z.string().min(1),
  action: z.enum(['set', 'add', 'remove']),
  value: nonNullMetadataValueSchema.optional(),
});

export const bulkMetadataSchema = z.object({
  modelIds: z.array(z.string().uuid()).min(1, 'At least one model ID is required'),
  operations: z.array(bulkMetadataOperationSchema).min(1, 'At least one operation is required'),
});
