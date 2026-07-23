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
  fieldSlug: z.string().trim().min(1).max(255),
  action: z.enum(['set', 'add', 'remove']),
  value: nonNullMetadataValueSchema.optional(),
}).superRefine((operation, context) => {
  if (operation.action !== 'add') return;
  const values = typeof operation.value === 'string'
    ? [operation.value]
    : operation.value;
  if (!Array.isArray(values) || values.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['value'],
      message: 'Add operations require one or more tag names',
    });
    return;
  }
  values.forEach((value, index) => {
    if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 255) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value', index],
        message: 'Tag names must be between 1 and 255 characters after trimming',
      });
    }
  });
});

export const bulkMetadataSchema = z.object({
  modelIds: z.array(z.string().uuid()).min(1, 'At least one model ID is required').max(500)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'Model IDs must be unique',
    }),
  operations: z.array(bulkMetadataOperationSchema)
    .min(1, 'At least one operation is required')
    .max(25),
});
