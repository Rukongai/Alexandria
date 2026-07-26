import { z } from 'zod';
import { setModelMetadataSchema } from './metadata.js';
import { batchUploadMetadataSchema, importFileLayoutPlanSchema } from './upload.js';

const httpUrlSchema = z.string().url().max(2048).refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === 'http:' || protocol === 'https:';
}, 'Base URL must use http or https');

export const createAiProviderSchema = z.object({
  name: z.string().trim().min(1).max(255),
  baseUrl: httpUrlSchema,
  apiKey: z.string().max(4096).optional(),
  model: z.string().trim().min(1).max(255),
  isDefault: z.boolean().optional(),
});

export const updateAiProviderSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  baseUrl: httpUrlSchema.optional(),
  apiKey: z.string().max(4096).nullable().optional(),
  model: z.string().trim().min(1).max(255).optional(),
  isDefault: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one field is required',
});

export const aiProviderIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const aiChatSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1).max(8000),
  })).max(20).optional(),
  providerId: z.string().uuid().optional(),
  context: z.object({
    modelId: z.string().uuid().optional(),
    modelIds: z.array(z.string().uuid()).max(25).optional(),
    importSessionIds: z.array(z.string().uuid()).max(25).optional(),
  }).optional(),
}).superRefine((value, context) => {
  const totalCharacters = value.message.length
    + (value.history ?? []).reduce((sum, message) => sum + message.content.length, 0);
  if (totalCharacters > 32_000) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['history'],
      message: 'Message and history must contain at most 32000 characters total',
    });
  }
  const modelIds = [
    ...(value.context?.modelId ? [value.context.modelId] : []),
    ...(value.context?.modelIds ?? []),
  ];
  if (new Set(modelIds).size > 25) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['context', 'modelIds'],
      message: 'At most 25 model targets are allowed',
    });
  }
  if ((value.context?.modelIds && new Set(value.context.modelIds).size !== value.context.modelIds.length)
    || (value.context?.importSessionIds
      && new Set(value.context.importSessionIds).size !== value.context.importSessionIds.length)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['context'],
      message: 'Context target IDs must be unique',
    });
  }
});

const updateModelChangeSchema = z.object({
  type: z.literal('update_model'),
  modelId: z.string().uuid(),
  modelName: z.string().min(1).max(255),
  patch: z.object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(20_000).nullable().optional(),
    previewImageFileId: z.string().uuid().nullable().optional(),
  }).refine((value) => Object.keys(value).length > 0, {
    message: 'At least one model field is required',
  }),
});

const setMetadataChangeSchema = z.object({
  type: z.literal('set_metadata'),
  modelId: z.string().uuid(),
  modelName: z.string().min(1).max(255),
  values: setModelMetadataSchema.refine((value) => Object.keys(value).length > 0, {
    message: 'At least one metadata value is required',
  }),
});

const updateCollectionsChangeSchema = z.object({
  type: z.literal('update_collections'),
  modelId: z.string().uuid(),
  modelName: z.string().min(1).max(255),
  addCollectionIds: z.array(z.string().uuid()).max(50).default([]),
  removeCollectionIds: z.array(z.string().uuid()).max(50).default([]),
}).refine(
  (value) => value.addCollectionIds.length > 0 || value.removeCollectionIds.length > 0,
  { message: 'At least one collection change is required' },
);

const updateImportSessionChangeSchema = z.object({
  type: z.literal('update_import_session'),
  importSessionId: z.string().uuid(),
  originalFilename: z.string().min(1).max(512),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  patch: batchUploadMetadataSchema.refine((value) => {
    const directKeys = ['modelName', 'description', 'collectionId', 'newCollectionName', 'artist', 'tags'] as const;
    return directKeys.some((key) => key in value)
      || (value.metadata !== undefined && Object.keys(value.metadata).length > 0)
      || (value.options !== undefined && Object.keys(value.options).length > 0);
  }, {
    message: 'At least one staged metadata field is required',
  }),
});

const organizeImportSessionFilesChangeSchema = z.object({
  type: z.literal('organize_import_session_files'),
  importSessionId: z.string().uuid(),
  originalFilename: z.string().min(1).max(512),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  layout: importFileLayoutPlanSchema,
});

const aiBulkModelIdsSchema = z.array(z.string().uuid()).min(1).max(500)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: 'Bulk model IDs must be unique',
  });

const aiBulkMetadataOperationSchema = z.object({
  fieldSlug: z.string().trim().min(1).max(255),
  action: z.enum(['set', 'add', 'remove']),
  value: z.union([
    z.string().max(10_000),
    z.array(z.string().max(10_000)).max(100),
    z.number().finite(),
    z.boolean(),
  ]).optional(),
}).superRefine((operation, context) => {
  if (operation.action !== 'remove' && operation.value === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['value'],
      message: `${operation.action} metadata operations require a value`,
    });
  }
  if (operation.action === 'remove' && operation.value !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['value'],
      message: 'remove metadata operations must not include a value',
    });
  }
  if (operation.fieldSlug === 'tags' && operation.action !== 'remove') {
    const values = typeof operation.value === 'string' ? [operation.value] : operation.value;
    if (operation.action === 'add' && (!Array.isArray(values) || values.length === 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'Add operations require one or more tag names',
      });
      return;
    }
    if (Array.isArray(values)) {
      values.forEach((value, index) => {
        if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 255) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['value', index],
            message: 'Tag names must be between 1 and 255 characters after trimming',
          });
        }
      });
    }
  }
});

const aiBulkCollectionOperationSchema = z.object({
  collectionId: z.string().uuid(),
  action: z.enum(['add', 'remove']),
});

const bulkMetadataChangeSchema = z.object({
  type: z.literal('bulk_metadata'),
  modelIds: aiBulkModelIdsSchema,
  operations: z.array(aiBulkMetadataOperationSchema).min(1).max(25),
}).superRefine((change, context) => {
  const fieldSlugs = change.operations.map((operation) => operation.fieldSlug);
  if (new Set(fieldSlugs).size !== fieldSlugs.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['operations'],
      message: 'Bulk metadata operations must target distinct fields',
    });
  }
});

const bulkCollectionsChangeSchema = z.object({
  type: z.literal('bulk_collections'),
  modelIds: aiBulkModelIdsSchema,
  operations: z.array(aiBulkCollectionOperationSchema).min(1).max(50),
}).superRefine((change, context) => {
  const collectionIds = change.operations.map((operation) => operation.collectionId);
  if (new Set(collectionIds).size !== collectionIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['operations'],
      message: 'Bulk collection operations must target distinct collections',
    });
  }
});

export const aiChangeSchema = z.union([
  updateModelChangeSchema,
  setMetadataChangeSchema,
  updateCollectionsChangeSchema,
  updateImportSessionChangeSchema,
  organizeImportSessionFilesChangeSchema,
  bulkMetadataChangeSchema,
  bulkCollectionsChangeSchema,
]);

export const aiChangeSetSchema = z.object({
  summary: z.string().trim().min(1).max(1000),
  changes: z.array(aiChangeSchema).min(1).max(25),
});

export const aiBulkChangeSetSchema = z.object({
  summary: z.string().trim().min(1).max(1000),
  target: z.object({
    scope: z.enum(['current_models', 'active_library']),
  }),
  metadataOperations: z.array(aiBulkMetadataOperationSchema).min(1).max(25).optional(),
  collectionOperations: z.array(aiBulkCollectionOperationSchema).min(1).max(50).optional(),
}).superRefine((value, context) => {
  if (!value.metadataOperations && !value.collectionOperations) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['metadataOperations'],
      message: 'At least one bulk operation is required',
    });
  }
  const fieldSlugs = (value.metadataOperations ?? []).map((operation) => operation.fieldSlug);
  if (new Set(fieldSlugs).size !== fieldSlugs.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['metadataOperations'],
      message: 'Bulk metadata operations must target distinct fields',
    });
  }
  const collectionIds = (value.collectionOperations ?? [])
    .map((operation) => operation.collectionId);
  if (new Set(collectionIds).size !== collectionIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['collectionOperations'],
      message: 'Bulk collection operations must target distinct collections',
    });
  }
});

export const aiProposalIdParamsSchema = z.object({
  id: z.string().uuid(),
});
