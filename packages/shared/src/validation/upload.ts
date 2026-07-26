import { z } from 'zod';
import { SUPPORTED_ARCHIVE_EXTENSIONS } from '../constants/index.js';
import { setModelMetadataSchema } from './metadata.js';

const isSupportedArchiveFilename = (filename: string): boolean => {
  const lower = filename.toLowerCase();
  return SUPPORTED_ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
};

const isSplitArchivePartFilename = (filename: string): boolean =>
  /\.z(?:0[1-9]|[1-9]\d)$/i.test(filename)
  || /\.zip\.(?:00[1-9]|0[1-9]\d|[1-9]\d{2})$/i.test(filename)
  || /\.part(?:0*[1-9]\d*)\.rar$/i.test(filename);

const isMultipartArchiveFilename = (filename: string): boolean => {
  if (/\.part\d+\.rar$/i.test(filename)) {
    return /\.part(?:0*[1-9]\d*)\.rar$/i.test(filename);
  }
  return isSupportedArchiveFilename(filename) || isSplitArchivePartFilename(filename);
};

export const uploadInitSchema = z.object({
  filename: z.string().min(1).max(512).refine(
    isSupportedArchiveFilename,
    { message: 'File must be a supported archive format (.zip, .rar, .7z, .tar.gz)' },
  ),
  totalSize: z.number().int().positive().max(5 * 1024 * 1024 * 1024), // 5GB
  totalChunks: z.number().int().positive().max(1000),
});

export const multipartUploadInitSchema = uploadInitSchema.extend({
  filename: z.string().min(1).max(512).refine(
    isMultipartArchiveFilename,
    {
      message: 'File must be a supported archive or split archive part (.z01-.z99, .zip.001-.zip.999, .partN.rar)',
    },
  ),
});

export const completeMultipartUploadSchema = z.object({
  uploadIds: z.array(z.string().uuid()).min(2).max(100).refine(
    (uploadIds) => new Set(uploadIds).size === uploadIds.length,
    { message: 'Upload IDs must be unique' },
  ),
  mode: z.enum(['combine', 'split']),
});

export const chunkIndexParamsSchema = z.object({
  uploadId: z.string().uuid(),
  index: z.coerce.number().int().min(0),
});

export const uploadCompleteParamsSchema = z.object({
  uploadId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Staged upload: review/commit
// ---------------------------------------------------------------------------

export const uploadOptionsSchema = z.object({
  markPreSupported: z.boolean().optional(),
  autoThumbnails: z.boolean().optional(),
  markNsfw: z.boolean().optional(),
  skipDuplicatesByHash: z.boolean().optional(),
});

export const batchUploadMetadataSchema = z.object({
  modelName: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
  collectionId: z.string().uuid().optional(),
  newCollectionName: z.string().min(1).max(255).optional(),
  artist: z.string().max(255).optional(),
  tags: z.array(z.string().min(1).max(100)).max(50).optional(),
  metadata: setModelMetadataSchema.optional(),
  options: uploadOptionsSchema.optional(),
}).refine(
  (value) => !(value.collectionId && value.newCollectionName),
  { message: 'Choose either an existing collection or a new collection, not both' },
);

/**
 * Lenient parse of an archive's root metadata.json, used only to prefill the
 * review form. Each field independently catches to undefined, so one malformed
 * value never costs the author the rest of a hand-written file, and unknown
 * keys (the importer's `source`, `result`, `schemaVersion`) are stripped.
 *
 * `metadata` is one field, not many: it validates as a whole record, so a
 * single bad value inside drops the entire object rather than that one key.
 *
 * `collectionId` is deliberately absent. A collection UUID is meaningful only
 * in the library it came from, and the review form's collection picker cannot
 * render an option it does not have — prefilling one would submit a
 * destination the user was never shown, failing a commit that would otherwise
 * have succeeded. `newCollectionName` is the portable form.
 */
export const metadataFileSchema = z.object({
  modelName: z.string().min(1).max(255).optional().catch(undefined),
  description: z.string().max(2000).optional().catch(undefined),
  artist: z.string().max(255).optional().catch(undefined),
  tags: z.array(z.string().min(1).max(100)).max(50).optional().catch(undefined),
  metadata: setModelMetadataSchema.optional().catch(undefined),
  newCollectionName: z.string().min(1).max(255).optional().catch(undefined),
});

const layoutPathSchema = z.string().trim().max(1000);

export const importFileLayoutPlanSchema = z.object({
  rootFolders: z.tuple([z.literal('Model'), z.literal('Images')]),
  prefixMappings: z.array(z.object({
    sourcePrefix: layoutPathSchema,
    destinationPrefix: layoutPathSchema.min(1),
  })).max(100),
  fileMappings: z.array(z.object({
    sourcePath: layoutPathSchema.min(1),
    destinationPath: layoutPathSchema.min(1),
  })).max(100).optional(),
}).superRefine((layout, context) => {
  if (layout.prefixMappings.length === 0 && (layout.fileMappings?.length ?? 0) === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['prefixMappings'],
      message: 'At least one file layout mapping is required',
    });
  }
  for (const [field, values] of [
    ['prefixMappings', layout.prefixMappings.map((mapping) => mapping.sourcePrefix)],
    ['fileMappings', (layout.fileMappings ?? []).map((mapping) => mapping.sourcePath)],
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field === 'prefixMappings' ? 'Source prefixes' : 'Source file paths'} must be unique`,
      });
    }
  }
});

export const commitImportSessionSchema = z.object({
  batchMetadata: batchUploadMetadataSchema.optional(),
});

export const importSessionIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const extractImportSessionArchiveSchema = z.object({
  relativePath: z.string().min(1).max(1000),
});

export type UploadInitRequest = z.infer<typeof uploadInitSchema>;
export type MultipartUploadInitRequest = z.infer<typeof multipartUploadInitSchema>;
export type ChunkIndexParams = z.infer<typeof chunkIndexParamsSchema>;
export type UploadCompleteParams = z.infer<typeof uploadCompleteParamsSchema>;
export type ExtractImportSessionArchiveRequest = z.infer<typeof extractImportSessionArchiveSchema>;
