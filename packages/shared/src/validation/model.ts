import { z } from 'zod';

const relativePathSchema = z.string().min(1).max(1000);
const optionalParentPathSchema = z.string().max(1000).optional();
const pathSegmentSchema = z.string().min(1).max(255);

export const updateModelSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().nullable().optional(),
  previewImageFileId: z.string().uuid().nullable().optional(),
  previewCropX: z.number().min(0).max(100).nullable().optional(),
  previewCropY: z.number().min(0).max(100).nullable().optional(),
  previewCropScale: z.number().min(1).max(10).nullable().optional(),
});

export const bulkDeleteSchema = z.object({
  modelIds: z.array(z.string().uuid()).min(1).max(500)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'Model IDs must be unique',
    }),
});

export const mergeModelsSchema = z.object({
  sourceModelIds: z.array(z.string().uuid()).min(1).max(100),
});

export const createModelFolderSchema = z.object({
  path: relativePathSchema,
});

export const updateModelFileSchema = z
  .object({
    filename: pathSegmentSchema.optional(),
    parentPath: optionalParentPathSchema,
  })
  .refine((data) => data.filename !== undefined || data.parentPath !== undefined, {
    message: 'filename or parentPath is required',
  });

export const updateModelFolderSchema = z
  .object({
    path: relativePathSchema,
    name: pathSegmentSchema.optional(),
    parentPath: optionalParentPathSchema,
  })
  .refine((data) => data.name !== undefined || data.parentPath !== undefined, {
    message: 'name or parentPath is required',
  });

export const deleteModelFolderSchema = z.object({
  path: relativePathSchema,
});

export const splitModelFolderSchema = z.object({
  path: relativePathSchema,
  name: z.string().trim().min(1).max(255),
  metadataFieldSlugs: z.array(z.string().trim().min(1).max(255))
    .max(100)
    .refine((slugs) => new Set(slugs).size === slugs.length, {
      message: 'Metadata field slugs must be unique',
    })
    .default([]),
});

export const compressModelFolderSchema = z.object({
  path: relativePathSchema,
});
