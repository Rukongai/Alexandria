import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { notFound, validationError } from '../utils/errors.js';
import {
  createAlexandriaMcpHandlers,
  createAlexandriaMcpServer,
  mcpScopeOptionsFromEnvironment,
  type McpDependencies,
} from './tools.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const LIBRARY_ID = '22222222-2222-4222-8222-222222222222';
const MODEL_ID = '33333333-3333-4333-8333-333333333333';

function modelRow(id = MODEL_ID) {
  return {
    id,
    name: 'Raw model',
    slug: 'raw-model',
    description: null,
    userId: USER_ID,
    libraryId: LIBRARY_ID,
    sourceType: 'manual',
    status: 'ready',
    originalFilename: null,
    totalSizeBytes: 12,
    fileCount: 1,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    searchVector: 'raw',
    previewImageFileId: null,
    previewCropX: null,
    previewCropY: null,
    previewCropScale: null,
  };
}

function dependencies(): McpDependencies {
  return {
    bulk: {
      deleteModels: vi.fn(async () => ({ deletedCount: 1, deletedIds: [MODEL_ID] })),
      setMetadata: vi.fn(async () => undefined),
    },
    database: {
      transaction: vi.fn(async (callback) => callback({} as never)),
    },
    library: {
      resolveLibraryId: vi.fn(async () => LIBRARY_ID),
    },
    model: {
      requireOwnedModel: vi.fn(async () => modelRow()),
      requireOwnedModels: vi.fn(async () => [modelRow()]),
      lockOwnedModels: vi.fn(async () => [modelRow()]),
      getModelFiles: vi.fn(async () => []),
      updateModel: vi.fn(async () => modelRow()),
      mergeModels: vi.fn(async () => ({
        targetModelId: MODEL_ID,
        mergedModelIds: [],
        movedFileCount: 0,
      })),
    },
    metadata: {
      getFieldBySlug: vi.fn(async () => ({
        id: '44444444-4444-4444-8444-444444444444',
        name: 'Tags',
        slug: 'tags',
        type: 'multi_enum',
        isDefault: true,
        isFilterable: true,
        isBrowsable: true,
        config: null,
        sortOrder: 1,
        createdAt: new Date(),
      })),
      normalizeAndValidateFieldValue: vi.fn((_field, value) => value as string[]),
      getModelMetadata: vi.fn(async () => []),
      setModelMetadata: vi.fn(async () => undefined),
    },
    search: {
      searchModels: vi.fn(async () => ({
        models: [{ id: MODEL_ID } as never],
        total: 1,
        cursor: null,
        pageSize: 50,
      })),
    },
    storage: {
      retrieveStream: vi.fn(async () => Readable.from('data')),
    },
    rawModels: {
      getRelatedModelInformation: vi.fn(async () => ({
        modelFiles: [],
        modelFolders: [],
        metadata: [],
        tags: { rows: [], memberships: [] },
        collections: { rows: [], memberships: [] },
        thumbnails: [],
      })),
    },
  };
}

describe('Alexandria MCP handlers', () => {
  it('resolves and enforces the configured user/library while returning raw search rows', async () => {
    const deps = dependencies();
    const { scope, handlers } = await createAlexandriaMcpHandlers({ userId: USER_ID }, deps);

    const result = await handlers.searchModels({ q: 'raw', pageSize: 25 });

    expect(scope.libraryId).toBe(LIBRARY_ID);
    expect(deps.library.resolveLibraryId).toHaveBeenCalledWith(USER_ID, undefined);
    expect(deps.search.searchModels).toHaveBeenCalledWith(
      { q: 'raw', pageSize: 25 },
      LIBRARY_ID,
    );
    expect(deps.model.requireOwnedModels).toHaveBeenCalledWith(
      [MODEL_ID],
      USER_ID,
      LIBRARY_ID,
    );
    expect(result.models).toEqual([modelRow()]);
  });

  it('checks ownership before loading raw related table rows', async () => {
    const deps = dependencies();
    const { handlers } = await createAlexandriaMcpHandlers({ userId: USER_ID }, deps);

    const result = await handlers.getModel({ modelId: MODEL_ID });

    expect(deps.model.requireOwnedModel).toHaveBeenCalledWith(
      MODEL_ID,
      USER_ID,
      LIBRARY_ID,
    );
    expect(deps.rawModels.getRelatedModelInformation).toHaveBeenCalledWith(MODEL_ID);
    expect(result.model).toEqual(modelRow());
  });

  it('does not query related tables when model ownership validation fails', async () => {
    const deps = dependencies();
    vi.mocked(deps.model.requireOwnedModel).mockRejectedValueOnce(
      notFound('Model not found'),
    );
    const { handlers } = await createAlexandriaMcpHandlers({ userId: USER_ID }, deps);

    await expect(handlers.getModel({ modelId: MODEL_ID })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    expect(deps.rawModels.getRelatedModelInformation).not.toHaveBeenCalled();
  });

  it('returns empty raw search results without running an ownership lookup', async () => {
    const deps = dependencies();
    vi.mocked(deps.search.searchModels).mockResolvedValueOnce({
      models: [],
      total: 0,
      cursor: null,
      pageSize: 25,
    });
    const { handlers } = await createAlexandriaMcpHandlers({ userId: USER_ID }, deps);

    const result = await handlers.searchModels({ q: 'missing', pageSize: 25 });

    expect(result).toEqual({ models: [], total: 0, cursor: null, pageSize: 25 });
    expect(deps.model.requireOwnedModels).not.toHaveBeenCalled();
  });

  it('removes only the requested tags in an ownership-locked transaction', async () => {
    const deps = dependencies();
    const transaction = { transaction: true } as never;
    vi.mocked(deps.database.transaction).mockImplementationOnce(
      async (callback) => callback(transaction),
    );
    vi.mocked(deps.metadata.getModelMetadata)
      .mockResolvedValueOnce([{
        fieldSlug: 'tags',
        fieldName: 'Tags',
        type: 'multi_enum',
        value: ['Dragon', 'Fantasy'],
        displayValue: 'Dragon, Fantasy',
      }])
      .mockResolvedValueOnce([{
        fieldSlug: 'tags',
        fieldName: 'Tags',
        type: 'multi_enum',
        value: ['Fantasy'],
        displayValue: 'Fantasy',
      }]);
    const { handlers } = await createAlexandriaMcpHandlers({ userId: USER_ID }, deps);

    const result = await handlers.tagModel({
      modelId: MODEL_ID,
      action: 'remove',
      tags: ['dragon'],
    });

    expect(deps.model.lockOwnedModels).toHaveBeenCalledWith(
      [MODEL_ID], USER_ID, LIBRARY_ID, transaction,
    );
    expect(deps.metadata.getModelMetadata).toHaveBeenNthCalledWith(
      1, MODEL_ID, transaction,
    );
    expect(deps.metadata.setModelMetadata).toHaveBeenCalledWith(
      MODEL_ID, { tags: ['Fantasy'] }, transaction,
    );
    expect(deps.bulk.setMetadata).not.toHaveBeenCalled();
    expect(result.tags).toEqual(['Fantasy']);
  });

  it.each([
    ['add', 'add'],
    ['replace', 'set'],
  ] as const)('maps the %s tag action to the bulk metadata operation', async (
    action,
    operation,
  ) => {
    const deps = dependencies();
    vi.mocked(deps.metadata.normalizeAndValidateFieldValue)
      .mockReturnValueOnce(['Dragon', 'Fantasy']);
    vi.mocked(deps.metadata.getModelMetadata).mockResolvedValueOnce([{
      fieldSlug: 'tags',
      fieldName: 'Tags',
      type: 'multi_enum',
      value: ['Dragon', 'Fantasy'],
      displayValue: 'Dragon, Fantasy',
    }]);
    const { handlers } = await createAlexandriaMcpHandlers({ userId: USER_ID }, deps);

    const result = await handlers.tagModel({
      modelId: MODEL_ID,
      action,
      tags: [' dragon ', 'fantasy'],
    });

    expect(deps.model.requireOwnedModel).toHaveBeenCalledWith(
      MODEL_ID,
      USER_ID,
      LIBRARY_ID,
    );
    expect(deps.metadata.normalizeAndValidateFieldValue).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'tags' }),
      [' dragon ', 'fantasy'],
    );
    expect(deps.bulk.setMetadata).toHaveBeenCalledWith(
      {
        modelIds: [MODEL_ID],
        operations: [{
          fieldSlug: 'tags',
          action: operation,
          value: ['Dragon', 'Fantasy'],
        }],
      },
      USER_ID,
      LIBRARY_ID,
    );
    expect(result.tags).toEqual(['Dragon', 'Fantasy']);
  });

  it('applies core and metadata updates in the same ownership-locked transaction', async () => {
    const deps = dependencies();
    const transaction = { transaction: true } as never;
    vi.mocked(deps.database.transaction).mockImplementationOnce(
      async (callback) => callback(transaction),
    );
    const { handlers } = await createAlexandriaMcpHandlers({ userId: USER_ID }, deps);

    await handlers.updateModel({
      modelId: MODEL_ID,
      updates: { name: 'Updated' },
      metadata: { artist: 'Alexandria' },
    });

    expect(deps.model.lockOwnedModels).toHaveBeenCalledWith(
      [MODEL_ID], USER_ID, LIBRARY_ID, transaction,
    );
    expect(deps.model.updateModel).toHaveBeenCalledWith(
      MODEL_ID, { name: 'Updated' }, transaction,
    );
    expect(deps.metadata.setModelMetadata).toHaveBeenCalledWith(
      MODEL_ID, { artist: 'Alexandria' }, transaction,
    );
  });

  it('does not read or return partially updated state when the transaction fails', async () => {
    const deps = dependencies();
    vi.mocked(deps.metadata.setModelMetadata).mockRejectedValueOnce(
      validationError('Invalid metadata', 'artist'),
    );
    const { handlers } = await createAlexandriaMcpHandlers({ userId: USER_ID }, deps);

    await expect(handlers.updateModel({
      modelId: MODEL_ID,
      updates: { name: 'Updated' },
      metadata: { artist: 'invalid' },
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'artist' });

    expect(deps.model.updateModel).toHaveBeenCalledOnce();
    expect(deps.model.requireOwnedModel).not.toHaveBeenCalled();
    expect(deps.metadata.getModelMetadata).not.toHaveBeenCalled();
  });

  it('delegates merge with the server-owned user and library scope', async () => {
    const deps = dependencies();
    const sourceModelId = '55555555-5555-4555-8555-555555555555';
    vi.mocked(deps.model.mergeModels).mockResolvedValueOnce({
      targetModelId: MODEL_ID,
      mergedModelIds: [sourceModelId],
      movedFileCount: 2,
    });
    const { handlers } = await createAlexandriaMcpHandlers({
      userId: USER_ID,
      libraryId: LIBRARY_ID,
    }, deps);

    const result = await handlers.mergeModels({
      targetModelId: MODEL_ID,
      sourceModelIds: [sourceModelId],
    });

    expect(deps.model.mergeModels).toHaveBeenCalledWith(
      MODEL_ID,
      [sourceModelId],
      USER_ID,
      LIBRARY_ID,
    );
    expect(result).toMatchObject({ mergedModelIds: [sourceModelId], movedFileCount: 2 });
  });

  it('delegates deletion to BulkService for atomic scope checks and cleanup', async () => {
    const deps = dependencies();
    const { handlers } = await createAlexandriaMcpHandlers({ userId: USER_ID }, deps);

    const result = await handlers.deleteModel({ modelId: MODEL_ID });

    expect(deps.bulk.deleteModels).toHaveBeenCalledWith(
      { modelIds: [MODEL_ID] },
      USER_ID,
      LIBRARY_ID,
    );
    expect(result).toEqual({
      deletedModelId: MODEL_ID,
      deletedCount: 1,
      deletedIds: [MODEL_ID],
    });
  });
});

describe('Alexandria MCP registration', () => {
  it('registers stable annotated tools and converts domain failures to tool errors', async () => {
    const deps = dependencies();
    vi.mocked(deps.model.requireOwnedModel).mockRejectedValue(notFound('Model not found'));
    const server = await createAlexandriaMcpServer({ userId: USER_ID }, deps);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        'alexandria_search_models',
        'alexandria_get_model',
        'alexandria_download_model_files',
        'alexandria_update_model',
        'alexandria_merge_models',
        'alexandria_delete_model',
        'alexandria_tag_model',
      ]);
      expect(Object.fromEntries(listed.tools.map((tool) => [tool.name, tool.annotations])))
        .toMatchObject({
          alexandria_search_models: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
          alexandria_get_model: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
          alexandria_download_model_files: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
          },
          alexandria_update_model: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false,
          },
          alexandria_merge_models: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false,
          },
          alexandria_delete_model: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false,
          },
          alexandria_tag_model: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
          },
        });

      const searchResult = await client.callTool({
        name: 'alexandria_search_models',
        arguments: { q: 'raw' },
      });
      expect(searchResult.isError).not.toBe(true);
      expect(searchResult.structuredContent).toMatchObject({
        models: [{ createdAt: '2026-01-01T00:00:00.000Z' }],
      });
      expect(((searchResult.content as Array<{ text: string }>)[0]).text)
        .toContain('"createdAt":"2026-01-01T00:00:00.000Z"');

      const result = await client.callTool({
        name: 'alexandria_get_model',
        arguments: { modelId: MODEL_ID },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: 'Model not found' }]);
      expect(result.structuredContent).toEqual({
        error: { code: 'NOT_FOUND', message: 'Model not found', field: null },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns JSON-safe structured data and redacts unexpected failures', async () => {
    const deps = dependencies();
    vi.mocked(deps.model.requireOwnedModels).mockResolvedValueOnce([{
      ...modelRow(),
      totalSizeBytes: 12n,
      internal: { indexedAt: new Date('2026-01-03T00:00:00.000Z') },
    } as never]);
    vi.mocked(deps.model.mergeModels).mockRejectedValueOnce(
      new Error('database password leaked here'),
    );
    const server = await createAlexandriaMcpServer({ userId: USER_ID }, deps);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const searchResult = await client.callTool({
        name: 'alexandria_search_models',
        arguments: { q: 'raw' },
      });
      expect(searchResult.structuredContent).toMatchObject({
        models: [{
          totalSizeBytes: '12',
          internal: { indexedAt: '2026-01-03T00:00:00.000Z' },
        }],
      });
      expect(((searchResult.content as Array<{ text: string }>)[0]).text)
        .toContain('"totalSizeBytes":"12"');

      const failure = await client.callTool({
        name: 'alexandria_merge_models',
        arguments: {
          targetModelId: MODEL_ID,
          sourceModelIds: ['55555555-5555-4555-8555-555555555555'],
        },
      });
      expect(failure.isError).toBe(true);
      expect(failure.structuredContent).toEqual({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Alexandria could not complete the operation',
          field: null,
        },
      });
      expect(JSON.stringify(failure)).not.toContain('database password');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects invalid tool input before invoking mutation handlers', async () => {
    const deps = dependencies();
    const server = await createAlexandriaMcpServer({ userId: USER_ID }, deps);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const emptyUpdate = await client.callTool({
        name: 'alexandria_update_model',
        arguments: { modelId: MODEL_ID },
      });
      const emptyAdd = await client.callTool({
        name: 'alexandria_tag_model',
        arguments: { modelId: MODEL_ID, action: 'add', tags: [] },
      });

      expect(emptyUpdate.isError).toBe(true);
      expect(emptyAdd.isError).toBe(true);
      expect(deps.database.transaction).not.toHaveBeenCalled();
      expect(deps.bulk.setMetadata).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('mcpScopeOptionsFromEnvironment', () => {
  it('requires a configured user UUID and accepts optional scope variables', () => {
    expect(() => mcpScopeOptionsFromEnvironment({})).toThrow(
      'ALEXANDRIA_MCP_USER_ID is required',
    );
    expect(mcpScopeOptionsFromEnvironment({
      ALEXANDRIA_MCP_USER_ID: USER_ID,
      ALEXANDRIA_MCP_LIBRARY_ID: LIBRARY_ID,
      ALEXANDRIA_MCP_DOWNLOAD_DIR: './downloads',
    })).toEqual({
      userId: USER_ID,
      libraryId: LIBRARY_ID,
      downloadDirectory: './downloads',
    });
  });

  it('rejects malformed user and library identifiers', () => {
    expect(() => mcpScopeOptionsFromEnvironment({
      ALEXANDRIA_MCP_USER_ID: 'not-a-uuid',
    })).toThrow('ALEXANDRIA_MCP_USER_ID must be a UUID');
    expect(() => mcpScopeOptionsFromEnvironment({
      ALEXANDRIA_MCP_USER_ID: USER_ID,
      ALEXANDRIA_MCP_LIBRARY_ID: 'not-a-uuid',
    })).toThrow('ALEXANDRIA_MCP_LIBRARY_ID must be a UUID');
  });
});
