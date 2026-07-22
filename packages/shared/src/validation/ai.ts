import { z } from 'zod';
import { setModelMetadataSchema } from './metadata.js';

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

export const aiChangeSchema = z.union([
  updateModelChangeSchema,
  setMetadataChangeSchema,
  updateCollectionsChangeSchema,
]);

export const aiChangeSetSchema = z.object({
  summary: z.string().trim().min(1).max(1000),
  changes: z.array(aiChangeSchema).min(1).max(25),
});

export const aiProposalIdParamsSchema = z.object({
  id: z.string().uuid(),
});
