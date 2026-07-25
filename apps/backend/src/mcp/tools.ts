import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  mergeModelsSchema,
  modelSearchParamsSchema,
  setModelMetadataSchema,
  updateModelSchema,
} from '@alexandria/shared';
import type {
  ModelSearchParams,
  SetModelMetadataRequest,
  UpdateModelRequest,
} from '@alexandria/shared';
import { z } from 'zod';
import { db } from '../db/index.js';
import { bulkService } from '../services/bulk.service.js';
import { libraryService } from '../services/library.service.js';
import { metadataService } from '../services/metadata.service.js';
import { modelService } from '../services/model.service.js';
import { searchService } from '../services/search.service.js';
import { storageService } from '../services/storage.service.js';
import { AppError, notFound, validationError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { downloadModelFiles } from './download.js';
import {
  rawModelRepository,
  type RawModelInformation,
  type RawModelRepository,
} from './repository.js';

const logger = createLogger('McpTools');

const modelIdSchema = z.object({ modelId: z.string().uuid() });
const mergeModelInputSchema = z.object({ targetModelId: z.string().uuid() })
  .merge(mergeModelsSchema);
const downloadInputSchema = z.object({
  modelId: z.string().uuid(),
  fileIds: z.array(z.string().uuid()).min(1).max(1_000)
    .refine((ids) => new Set(ids).size === ids.length, 'File IDs must be unique')
    .optional(),
  subdirectory: z.string().min(1).max(1_000),
  overwrite: z.boolean().default(false),
});
const updateInputSchema = z.object({
  modelId: z.string().uuid(),
  updates: updateModelSchema.optional(),
  metadata: setModelMetadataSchema.optional(),
}).refine(
  (input) => input.updates !== undefined || input.metadata !== undefined,
  'updates or metadata is required',
);
const tagInputSchema = z.object({
  modelId: z.string().uuid(),
  action: z.enum(['add', 'remove', 'replace']),
  tags: z.array(z.string().trim().min(1).max(255)).max(100),
}).superRefine((input, context) => {
  if (input.action !== 'replace' && input.tags.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['tags'],
      message: `${input.action} requires at least one tag`,
    });
  }
});

export interface McpScopeOptions {
  userId: string;
  libraryId?: string;
  downloadDirectory?: string;
}

export interface ResolvedMcpScope {
  userId: string;
  libraryId: string;
  downloadDirectory?: string;
}

export interface McpDependencies {
  bulk: Pick<typeof bulkService, 'deleteModels' | 'setMetadata'>;
  database: Pick<typeof db, 'transaction'>;
  library: Pick<typeof libraryService, 'resolveLibraryId'>;
  model: Pick<
    typeof modelService,
    | 'requireOwnedModel'
    | 'requireOwnedModels'
    | 'lockOwnedModels'
    | 'getModelFiles'
    | 'updateModel'
    | 'mergeModels'
  >;
  metadata: Pick<
    typeof metadataService,
    | 'getFieldBySlug'
    | 'normalizeAndValidateFieldValue'
    | 'getModelMetadata'
    | 'setModelMetadata'
  >;
  search: Pick<typeof searchService, 'searchModels'>;
  storage: Pick<typeof storageService, 'retrieveStream'>;
  rawModels: RawModelRepository;
}

const defaultDependencies: McpDependencies = {
  bulk: bulkService,
  database: db,
  library: libraryService,
  model: modelService,
  metadata: metadataService,
  search: searchService,
  storage: storageService,
  rawModels: rawModelRepository,
};

export interface AlexandriaMcpHandlers {
  searchModels(params: ModelSearchParams): Promise<Record<string, unknown>>;
  getModel(input: z.infer<typeof modelIdSchema>): Promise<RawModelInformation>;
  downloadFiles(input: z.infer<typeof downloadInputSchema>): Promise<Record<string, unknown>>;
  updateModel(input: z.infer<typeof updateInputSchema>): Promise<Record<string, unknown>>;
  mergeModels(input: z.infer<typeof mergeModelInputSchema>): Promise<Record<string, unknown>>;
  deleteModel(input: z.infer<typeof modelIdSchema>): Promise<Record<string, unknown>>;
  tagModel(input: z.infer<typeof tagInputSchema>): Promise<Record<string, unknown>>;
}

function jsonSafe(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]),
    );
  }
  return value;
}

function successResult(summary: string, result: unknown): CallToolResult {
  const safeResult = jsonSafe(result) as Record<string, unknown>;
  return {
    content: [{ type: 'text', text: `${summary}\n${JSON.stringify(safeResult)}` }],
    structuredContent: safeResult,
  };
}

function errorResult(error: unknown): CallToolResult {
  if (error instanceof AppError) {
    return {
      isError: true,
      content: [{ type: 'text', text: error.message }],
      structuredContent: {
        error: { code: error.code, message: error.message, field: error.field ?? null },
      },
    };
  }

  logger.error({ service: 'McpTools', err: error }, 'Unexpected MCP tool failure');
  return {
    isError: true,
    content: [{ type: 'text', text: 'Alexandria could not complete the operation' }],
    structuredContent: {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Alexandria could not complete the operation',
        field: null,
      },
    },
  };
}

function safely<TArgs>(
  handler: (args: TArgs) => Promise<{ summary: string; result: unknown }>,
): (args: TArgs) => Promise<CallToolResult> {
  return async (args) => {
    try {
      const { summary, result } = await handler(args);
      return successResult(summary, result);
    } catch (error) {
      return errorResult(error);
    }
  };
}

export async function createAlexandriaMcpHandlers(
  options: McpScopeOptions,
  dependencies: McpDependencies = defaultDependencies,
): Promise<{ scope: ResolvedMcpScope; handlers: AlexandriaMcpHandlers }> {
  const libraryId = await dependencies.library.resolveLibraryId(
    options.userId,
    options.libraryId,
  );
  const scope: ResolvedMcpScope = {
    userId: options.userId,
    libraryId,
    downloadDirectory: options.downloadDirectory
      ? path.resolve(options.downloadDirectory)
      : undefined,
  };

  const requireOwnedModel = (modelId: string) =>
    dependencies.model.requireOwnedModel(modelId, scope.userId, scope.libraryId);

  const handlers: AlexandriaMcpHandlers = {
    async searchModels(params) {
      const searchResult = await dependencies.search.searchModels(params, scope.libraryId);
      const resultIds = searchResult.models.map((model) => model.id);
      const ownedRows = resultIds.length > 0
        ? await dependencies.model.requireOwnedModels(
          resultIds,
          scope.userId,
          scope.libraryId,
        )
        : [];
      const rowsById = new Map(ownedRows.map((row) => [row.id, row]));
      return {
        models: resultIds.map((id) => rowsById.get(id)),
        total: searchResult.total,
        cursor: searchResult.cursor,
        pageSize: searchResult.pageSize,
      };
    },

    async getModel({ modelId }) {
      const model = await requireOwnedModel(modelId);
      const related = await dependencies.rawModels.getRelatedModelInformation(modelId);
      return { model, ...related } as RawModelInformation;
    },

    async downloadFiles({ modelId, fileIds, subdirectory, overwrite }) {
      await requireOwnedModel(modelId);
      const allFiles = await dependencies.model.getModelFiles(modelId);
      let selectedFiles = allFiles;
      if (fileIds) {
        const filesById = new Map(allFiles.map((file) => [file.id, file]));
        if (fileIds.some((id) => !filesById.has(id))) {
          throw notFound('One or more model files were not found');
        }
        selectedFiles = fileIds.map((id) => filesById.get(id)!);
      }
      if (selectedFiles.length === 0) {
        throw notFound('The model has no files to download');
      }
      if (!scope.downloadDirectory) {
        throw validationError(
          'ALEXANDRIA_MCP_DOWNLOAD_DIR must be configured before downloading files',
        );
      }

      const downloaded = await downloadModelFiles({
        downloadDirectory: scope.downloadDirectory,
        subdirectory,
        files: selectedFiles,
        overwrite,
        storage: dependencies.storage,
      });
      return {
        modelId,
        downloadDirectory: scope.downloadDirectory,
        subdirectory,
        fileCount: downloaded.length,
        files: downloaded,
      };
    },

    async updateModel({ modelId, updates, metadata }) {
      await dependencies.database.transaction(async (transaction) => {
        await dependencies.model.lockOwnedModels(
          [modelId],
          scope.userId,
          scope.libraryId,
          transaction,
        );
        if (updates) {
          await dependencies.model.updateModel(
            modelId,
            updates as UpdateModelRequest,
            transaction,
          );
        }
        if (metadata) {
          await dependencies.metadata.setModelMetadata(
            modelId,
            metadata as SetModelMetadataRequest,
            transaction,
          );
        }
      });
      const [model, currentMetadata] = await Promise.all([
        requireOwnedModel(modelId),
        dependencies.metadata.getModelMetadata(modelId),
      ]);
      return { model, metadata: currentMetadata };
    },

    async mergeModels({ targetModelId, sourceModelIds }) {
      const result = await dependencies.model.mergeModels(
        targetModelId,
        sourceModelIds,
        scope.userId,
        scope.libraryId,
      );
      return result as unknown as Record<string, unknown>;
    },

    async deleteModel({ modelId }) {
      const result = await dependencies.bulk.deleteModels(
        { modelIds: [modelId] },
        scope.userId,
        scope.libraryId,
      );
      return { deletedModelId: modelId, ...result };
    },

    async tagModel({ modelId, action, tags }) {
      await requireOwnedModel(modelId);
      const field = await dependencies.metadata.getFieldBySlug('tags');
      const normalized = dependencies.metadata.normalizeAndValidateFieldValue(field, tags);
      const normalizedTags = normalized as string[];

      if (action === 'add') {
        await dependencies.bulk.setMetadata(
          {
            modelIds: [modelId],
            operations: [{ fieldSlug: 'tags', action: 'add', value: normalizedTags }],
          },
          scope.userId,
          scope.libraryId,
        );
      } else if (action === 'replace') {
        await dependencies.bulk.setMetadata(
          {
            modelIds: [modelId],
            operations: [{ fieldSlug: 'tags', action: 'set', value: normalizedTags }],
          },
          scope.userId,
          scope.libraryId,
        );
      } else {
        await dependencies.database.transaction(async (transaction) => {
          await dependencies.model.lockOwnedModels(
            [modelId],
            scope.userId,
            scope.libraryId,
            transaction,
          );
          const currentMetadata = await dependencies.metadata.getModelMetadata(
            modelId,
            transaction,
          );
          const currentTags = currentMetadata.find((item) => item.fieldSlug === 'tags')?.value;
          const removeNames = new Set(normalizedTags.map((tag) => tag.toLowerCase()));
          const remaining = Array.isArray(currentTags)
            ? currentTags.filter(
              (tag): tag is string =>
                typeof tag === 'string' && !removeNames.has(tag.toLowerCase()),
            )
            : [];
          await dependencies.metadata.setModelMetadata(
            modelId,
            { tags: remaining },
            transaction,
          );
        });
      }

      const currentMetadata = await dependencies.metadata.getModelMetadata(modelId);
      const currentTags = currentMetadata.find((item) => item.fieldSlug === 'tags')?.value;
      return {
        modelId,
        action,
        tags: Array.isArray(currentTags) ? currentTags : [],
      };
    },
  };

  return { scope, handlers };
}

export async function createAlexandriaMcpServer(
  options: McpScopeOptions,
  dependencies: McpDependencies = defaultDependencies,
): Promise<McpServer> {
  const { scope, handlers } = await createAlexandriaMcpHandlers(options, dependencies);
  const server = new McpServer({ name: 'alexandria', version: '1.0.0' });

  server.registerTool('alexandria_search_models', {
    title: 'Search Alexandria models',
    description: 'Search the configured Alexandria library and return full raw model table rows.',
    inputSchema: modelSearchParamsSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, safely(async (params) => {
    const result = await handlers.searchModels(params);
    const count = Array.isArray(result.models) ? result.models.length : 0;
    return { summary: `Found ${count} model${count === 1 ? '' : 's'}.`, result };
  }));

  server.registerTool('alexandria_get_model', {
    title: 'Get raw Alexandria model information',
    description: 'Return every raw model column and all related file, folder, metadata, tag, collection, and thumbnail rows. No presenter shaping is applied.',
    inputSchema: modelIdSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, safely(async (input) => ({
    summary: `Loaded complete raw information for model ${input.modelId}.`,
    result: await handlers.getModel(input),
  })));

  server.registerTool('alexandria_download_model_files', {
    title: 'Download Alexandria model files',
    description: `Stream one, many, or all model files into a safe subdirectory beneath ${scope.downloadDirectory ?? 'ALEXANDRIA_MCP_DOWNLOAD_DIR'}.`,
    inputSchema: downloadInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, safely(async (input) => {
    const result = await handlers.downloadFiles(input);
    return { summary: `Downloaded ${String(result.fileCount)} model file(s).`, result };
  }));

  server.registerTool('alexandria_update_model', {
    title: 'Update an Alexandria model',
    description: 'Update owned model fields and/or validated metadata values in the configured library.',
    inputSchema: updateInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, safely(async (input) => ({
    summary: `Updated model ${input.modelId}.`,
    result: await handlers.updateModel(input),
  })));

  server.registerTool('alexandria_merge_models', {
    title: 'Merge Alexandria models',
    description: 'Merge owned ready source models into an owned ready target model in the configured library.',
    inputSchema: mergeModelInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, safely(async (input) => ({
    summary: `Merged ${input.sourceModelIds.length} model(s) into ${input.targetModelId}.`,
    result: await handlers.mergeModels(input),
  })));

  server.registerTool('alexandria_delete_model', {
    title: 'Delete an Alexandria model',
    description: 'Delete an owned model from the configured library and attempt cleanup of every managed file.',
    inputSchema: modelIdSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, safely(async (input) => ({
    summary: `Deleted model ${input.modelId}.`,
    result: await handlers.deleteModel(input),
  })));

  server.registerTool('alexandria_tag_model', {
    title: 'Tag an Alexandria model',
    description: 'Add, remove, or replace tags on an owned model using Alexandria metadata validation.',
    inputSchema: tagInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, safely(async (input) => {
    const result = await handlers.tagModel(input);
    return { summary: `${input.action} tags on model ${input.modelId}.`, result };
  }));

  return server;
}

export function mcpScopeOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): McpScopeOptions {
  const userId = environment.ALEXANDRIA_MCP_USER_ID?.trim();
  if (!userId) {
    throw new Error('ALEXANDRIA_MCP_USER_ID is required');
  }
  if (!z.string().uuid().safeParse(userId).success) {
    throw new Error('ALEXANDRIA_MCP_USER_ID must be a UUID');
  }

  const libraryId = environment.ALEXANDRIA_MCP_LIBRARY_ID?.trim() || undefined;
  if (libraryId && !z.string().uuid().safeParse(libraryId).success) {
    throw new Error('ALEXANDRIA_MCP_LIBRARY_ID must be a UUID');
  }
  const downloadDirectory = environment.ALEXANDRIA_MCP_DOWNLOAD_DIR?.trim() || undefined;

  return { userId, libraryId, downloadDirectory };
}
