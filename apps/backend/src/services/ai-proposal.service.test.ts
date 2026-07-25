import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { AiProposalService } from './ai-proposal.service.js';
import { MetadataService } from './metadata.service.js';
import { notFound } from '../utils/errors.js';

const PROPOSAL_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const LIBRARY_ID = '33333333-3333-4333-8333-333333333333';
const MODEL_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_MODEL_ID = '88888888-8888-4888-8888-888888888888';
const COLLECTION_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_COLLECTION_ID = '66666666-6666-4666-8666-666666666666';
const IMPORT_SESSION_ID = '77777777-7777-4777-8777-777777777777';
const NOW = new Date('2026-07-21T12:00:00.000Z');
const EXPECTED_UPDATED_AT = '2026-07-21T11:00:00.000Z';

function dependencies() {
  return {
    models: {
      requireOwnedModel: vi.fn().mockResolvedValue({ id: MODEL_ID, name: 'Dragon' }),
      requireOwnedModels: vi.fn().mockImplementation(async (ids: string[]) =>
        ids.map((id) => ({ id, name: id === MODEL_ID ? 'Dragon' : 'Castle' }))),
      listOwnedModelIds: vi.fn().mockResolvedValue([MODEL_ID, OTHER_MODEL_ID]),
      lockOwnedModels: vi.fn().mockResolvedValue([{ id: MODEL_ID, name: 'Dragon' }]),
      getModelFiles: vi.fn().mockResolvedValue([]),
      updateModel: vi.fn().mockResolvedValue({ id: MODEL_ID }),
    },
    metadata: {
      getFieldBySlug: vi.fn().mockResolvedValue({ slug: 'artist' }),
      setModelMetadata: vi.fn().mockResolvedValue(undefined),
      validateBulkOperations: vi.fn().mockResolvedValue(undefined),
      bulkSetMetadata: vi.fn().mockResolvedValue(undefined),
      validateFieldValue: vi.fn(),
      normalizeAndValidateFieldValue: vi.fn((_field, value) => value),
    },
    collections: {
      requireOwnedCollection: vi.fn().mockResolvedValue(undefined),
      getCollectionById: vi.fn().mockImplementation(async (id: string) => ({ id, name: `Collection ${id}` })),
      addModelsToCollection: vi.fn().mockResolvedValue(undefined),
      removeModelFromCollection: vi.fn().mockResolvedValue(undefined),
      removeModelsFromCollection: vi.fn().mockResolvedValue(undefined),
    },
    importSessions: {
      getOwnedReadyForReviewRow: vi.fn().mockResolvedValue({
        id: IMPORT_SESSION_ID,
        originalFilename: 'Maker - 2024 - Dragon.zip',
        updatedAt: new Date(EXPECTED_UPDATED_AT),
        draftMetadata: { metadata: { source: 'Existing Source', year: '2024' } },
      }),
      lockOwnedReadyForReviewSessions: vi.fn().mockResolvedValue([]),
      updateDraftMetadata: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function selectChain(rows: unknown[]) {
  const chain = { from: vi.fn(), where: vi.fn(), limit: vi.fn() };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.limit.mockResolvedValue(rows);
  return chain;
}

function proposalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROPOSAL_ID,
    userId: USER_ID,
    libraryId: LIBRARY_ID,
    status: 'pending',
    summary: 'Rename the model',
    changes: [{
      type: 'update_model',
      modelId: MODEL_ID,
      modelName: 'Dragon',
      patch: { name: 'Red Dragon' },
    }],
    expiresAt: new Date(NOW.getTime() + 60_000),
    isExpired: false,
    appliedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

function updateChain(claimed = true) {
  const chain = { set: vi.fn(), where: vi.fn(), returning: vi.fn() };
  chain.set.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.returning.mockResolvedValue(claimed ? [{ id: PROPOSAL_ID }] : []);
  return chain;
}

function tagsField() {
  return {
    id: '99999999-9999-4999-8999-999999999999',
    name: 'Tags',
    slug: 'tags',
    type: 'multi_enum' as const,
    isDefault: true,
    isFilterable: true,
    isBrowsable: true,
    config: null,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function previewDatabase(insertChain: unknown, execute = vi.fn().mockResolvedValue(undefined)) {
  const tx = { insert: vi.fn().mockReturnValue(insertChain), execute };
  return {
    tx,
    database: {
      transaction: vi.fn().mockImplementation(async (callback) => callback(tx)),
    },
  };
}

describe('AiProposalService preview/apply invariant', () => {
  it('rejects a preview before persistence when model ownership/library validation fails', async () => {
    const deps = dependencies();
    deps.models.requireOwnedModel.mockRejectedValue(
      Object.assign(new Error('Model not found'), { code: 'NOT_FOUND', statusCode: 404 }),
    );
    const { tx, database } = previewDatabase({});
    const service = new AiProposalService(
      deps.models as never,
      deps.metadata as never,
      deps.collections as never,
      database as never,
      () => NOW,
    );

    await expect(service.createPreview(USER_ID, LIBRARY_ID, {
      summary: 'Rename it',
      changes: [{
        type: 'update_model', modelId: MODEL_ID, modelName: 'Dragon', patch: { name: 'New name' },
      }],
    })).rejects.toThrow('Model not found');
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('persists a detached exact validated payload with a 15-minute expiry', async () => {
    const deps = dependencies();
    const insertChain = { values: vi.fn(), returning: vi.fn() };
    insertChain.values.mockReturnValue(insertChain);
    insertChain.returning.mockResolvedValue([{ id: PROPOSAL_ID }]);
    const { database } = previewDatabase(insertChain);
    const service = new AiProposalService(
      deps.models as never,
      deps.metadata as never,
      deps.collections as never,
      database as never,
      () => NOW,
    );
    const input = {
      summary: 'Rename it',
      changes: [{
        type: 'update_model' as const,
        modelId: MODEL_ID,
        modelName: 'Dragon',
        patch: { name: 'New name' },
      }],
    };

    const preview = await service.createPreview(USER_ID, LIBRARY_ID, input);
    input.changes[0].patch.name = 'Client mutation after preview';

    const persisted = insertChain.values.mock.calls[0][0];
    expect(persisted.changes[0].patch.name).toBe('New name');
    expect(preview.changes[0]).toMatchObject({ patch: { name: 'New name' } });
    expect(preview.expiresAt).toBe('2026-07-21T12:15:00.000Z');
    expect(deps.models.updateModel).not.toHaveBeenCalled();
    expect(deps.metadata.setModelMetadata).not.toHaveBeenCalled();
    expect(deps.collections.addModelsToCollection).not.toHaveBeenCalled();
    expect(deps.collections.removeModelFromCollection).not.toHaveBeenCalled();
  });

  it('caps transaction statement timeout at the database limit for a long operation deadline', async () => {
    const deps = dependencies();
    const insertChain = { values: vi.fn(), returning: vi.fn() };
    insertChain.values.mockReturnValue(insertChain);
    insertChain.returning.mockResolvedValue([{ id: PROPOSAL_ID }]);
    const execute = vi.fn().mockResolvedValue(undefined);
    const { database } = previewDatabase(insertChain, execute);
    const service = new AiProposalService(
      deps.models as never,
      deps.metadata as never,
      deps.collections as never,
      database as never,
      () => NOW,
    );

    await service.createPreview(USER_ID, LIBRARY_ID, {
      summary: 'Rename it',
      changes: [{
        type: 'update_model', modelId: MODEL_ID, modelName: 'Dragon', patch: { name: 'New name' },
      }],
    }, { deadline: Date.now() + 90_000 });

    expect(execute).toHaveBeenCalledOnce();
    const timeoutQuery = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(timeoutQuery.params).toEqual(['45000ms']);
  });

  it.each([
    ['a blank tag', ['   ']],
    ['an oversized tag', ['x'.repeat(256)]],
  ])('rejects an individualized metadata preview containing %s', async (_label, tags) => {
    const deps = dependencies();
    const metadata = new MetadataService();
    vi.spyOn(metadata, 'getFieldBySlug').mockResolvedValue(tagsField());
    const { tx, database } = previewDatabase({});
    const service = new AiProposalService(
      deps.models as never,
      metadata,
      deps.collections as never,
      database as never,
      () => NOW,
    );

    await expect(service.createPreview(USER_ID, LIBRARY_ID, {
      summary: 'Set tags',
      changes: [{
        type: 'set_metadata', modelId: MODEL_ID, modelName: 'Dragon', values: { tags },
      }],
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('accepts a scalar tag for an individualized metadata preview', async () => {
    const deps = dependencies();
    const metadata = new MetadataService();
    vi.spyOn(metadata, 'getFieldBySlug').mockResolvedValue(tagsField());
    const insertChain = { values: vi.fn(), returning: vi.fn() };
    insertChain.values.mockReturnValue(insertChain);
    insertChain.returning.mockResolvedValue([{ id: PROPOSAL_ID }]);
    const { database } = previewDatabase(insertChain);
    const service = new AiProposalService(
      deps.models as never,
      metadata,
      deps.collections as never,
      database as never,
      () => NOW,
    );

    const preview = await service.createPreview(USER_ID, LIBRARY_ID, {
      summary: 'Set a tag',
      changes: [{
        type: 'set_metadata', modelId: MODEL_ID, modelName: 'Dragon',
        values: { tags: ' terrain ' },
      }],
    });

    expect(preview.changes[0]).toMatchObject({ values: { tags: ' terrain ' } });
    expect(insertChain.values).toHaveBeenCalledOnce();
  });

  it('adds server-resolved image and collection labels without changing stored actions', async () => {
    const deps = dependencies();
    const imageId = '77777777-7777-4777-8777-777777777777';
    deps.models.getModelFiles.mockResolvedValue([{
      id: imageId,
      modelId: MODEL_ID,
      filename: 'cover #1%.jpg',
      relativePath: 'reference images/cover #1%.jpg',
      fileType: 'image',
    }]);
    const insertChain = { values: vi.fn(), returning: vi.fn() };
    insertChain.values.mockReturnValue(insertChain);
    insertChain.returning.mockResolvedValue([{ id: PROPOSAL_ID }]);
    const { database } = previewDatabase(insertChain);
    const service = new AiProposalService(
      deps.models as never,
      deps.metadata as never,
      deps.collections as never,
      database as never,
      () => NOW,
    );

    const preview = await service.createPreview(USER_ID, LIBRARY_ID, {
      summary: 'Set cover and collection',
      changes: [
        {
          type: 'update_model', modelId: MODEL_ID, modelName: 'Dragon',
          patch: { previewImageFileId: imageId },
        },
        {
          type: 'update_collections', modelId: MODEL_ID, modelName: 'Dragon',
          addCollectionIds: [COLLECTION_ID], removeCollectionIds: [],
        },
      ],
    });

    expect(preview.display).toEqual({
      collections: { [COLLECTION_ID]: { name: `Collection ${COLLECTION_ID}` } },
      images: {
        [imageId]: {
          filename: 'cover #1%.jpg',
          thumbnailUrl: `/files/models/${MODEL_ID}/reference%20images/cover%20%231%25.jpg`,
        },
      },
    });
    expect(insertChain.values.mock.calls[0][0].changes).not.toHaveProperty('display');
  });

  it('should freeze only validated current model targets in a bulk preview', async () => {
    const deps = dependencies();
    const insertChain = { values: vi.fn(), returning: vi.fn() };
    insertChain.values.mockReturnValue(insertChain);
    insertChain.returning.mockResolvedValue([{ id: PROPOSAL_ID }]);
    const { tx, database } = previewDatabase(insertChain);
    const service = new AiProposalService(
      deps.models as never,
      deps.metadata as never,
      deps.collections as never,
      database as never,
      () => NOW,
    );
    const currentModelIds = [OTHER_MODEL_ID, MODEL_ID, OTHER_MODEL_ID];

    const preview = await service.createBulkPreview(USER_ID, LIBRARY_ID, {
      summary: 'Set the artist on current models',
      target: { scope: 'current_models' },
      metadataOperations: [{ fieldSlug: 'artist', action: 'set', value: 'Maker' }],
    }, currentModelIds);
    currentModelIds.length = 0;

    const frozenIds = [MODEL_ID, OTHER_MODEL_ID].sort();
    expect(deps.models.requireOwnedModels)
      .toHaveBeenCalledWith(frozenIds, USER_ID, LIBRARY_ID, tx);
    expect(deps.models.listOwnedModelIds).not.toHaveBeenCalled();
    expect(preview.changes).toEqual([{
      type: 'bulk_metadata',
      modelIds: frozenIds,
      operations: [{ fieldSlug: 'artist', action: 'set', value: 'Maker' }],
    }]);
    expect(preview.display?.bulkTarget).toEqual({
      scope: 'current_models',
      modelCount: 2,
      sampleModelNames: ['Dragon', 'Castle'],
    });
    expect(insertChain.values.mock.calls[0][0].changes).toEqual(preview.changes);
    expect(deps.models.updateModel).not.toHaveBeenCalled();
    expect(deps.metadata.bulkSetMetadata).not.toHaveBeenCalled();
  });

  it('should resolve and freeze active-library targets server-side', async () => {
    const deps = dependencies();
    const frozenIds = Array.from({ length: 6 }, (_, index) =>
      `a1000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    deps.models.listOwnedModelIds.mockResolvedValue([...frozenIds].reverse());
    deps.models.requireOwnedModels.mockResolvedValue(
      frozenIds.map((id, index) => ({ id, name: `Model ${index + 1}` })),
    );
    const insertChain = { values: vi.fn(), returning: vi.fn() };
    insertChain.values.mockReturnValue(insertChain);
    insertChain.returning.mockResolvedValue([{ id: PROPOSAL_ID }]);
    const { tx, database } = previewDatabase(insertChain);
    const service = new AiProposalService(
      deps.models as never,
      deps.metadata as never,
      deps.collections as never,
      database as never,
      () => NOW,
    );

    const preview = await service.createBulkPreview(USER_ID, LIBRARY_ID, {
      summary: 'Organize the active library',
      target: { scope: 'active_library' },
      metadataOperations: [{ fieldSlug: 'artist', action: 'remove' }],
      collectionOperations: [{ collectionId: COLLECTION_ID, action: 'add' }],
    }, [PROPOSAL_ID]);

    expect(deps.models.listOwnedModelIds)
      .toHaveBeenCalledWith(USER_ID, LIBRARY_ID, 501, tx);
    expect(deps.models.requireOwnedModels).toHaveBeenCalledTimes(1);
    expect(deps.models.requireOwnedModels)
      .toHaveBeenCalledWith(frozenIds, USER_ID, LIBRARY_ID, tx);
    expect(preview.changes).toEqual([
      {
        type: 'bulk_metadata',
        modelIds: frozenIds,
        operations: [{ fieldSlug: 'artist', action: 'remove' }],
      },
      {
        type: 'bulk_collections',
        modelIds: frozenIds,
        operations: [{ collectionId: COLLECTION_ID, action: 'add' }],
      },
    ]);
    expect(preview.display).toEqual({
      collections: { [COLLECTION_ID]: { name: `Collection ${COLLECTION_ID}` } },
      images: {},
      bulkTarget: {
        scope: 'active_library',
        modelCount: 6,
        sampleModelNames: ['Model 1', 'Model 2', 'Model 3', 'Model 4', 'Model 5'],
      },
    });
  });

  it.each([
    ['empty current targets', 'current_models', []],
    ['oversized current targets', 'current_models', Array.from({ length: 501 }, (_, index) =>
      `90000000-0000-4000-8000-${String(index).padStart(12, '0')}`)],
    ['empty active library', 'active_library', []],
    ['oversized active library', 'active_library', Array.from({ length: 501 }, (_, index) =>
      `a0000000-0000-4000-8000-${String(index).padStart(12, '0')}`)],
  ] as const)('should reject %s before bulk preview persistence', async (_label, scope, ids) => {
    const deps = dependencies();
    if (scope === 'active_library') deps.models.listOwnedModelIds.mockResolvedValue([...ids]);
    const { tx, database } = previewDatabase({});
    const service = new AiProposalService(
      deps.models as never,
      deps.metadata as never,
      deps.collections as never,
      database as never,
      () => NOW,
    );

    await expect(service.createBulkPreview(USER_ID, LIBRARY_ID, {
      summary: 'Tag many models',
      target: { scope },
      metadataOperations: [{ fieldSlug: 'tags', action: 'add', value: ['terrain'] }],
    }, scope === 'current_models' ? [...ids] : []))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(tx.insert).not.toHaveBeenCalled();
    expect(deps.models.requireOwnedModels).not.toHaveBeenCalled();
  });

  it('should reject unowned or wrong-library models before bulk preview persistence', async () => {
    const deps = dependencies();
    deps.models.requireOwnedModels.mockRejectedValue(notFound('One or more models were not found'));
    const { tx, database } = previewDatabase({});
    const service = new AiProposalService(
      deps.models as never,
      deps.metadata as never,
      deps.collections as never,
      database as never,
      () => NOW,
    );

    await expect(service.createBulkPreview(USER_ID, LIBRARY_ID, {
      summary: 'Tag current models',
      target: { scope: 'current_models' },
      metadataOperations: [{ fieldSlug: 'tags', action: 'add', value: ['terrain'] }],
    }, [MODEL_ID, OTHER_MODEL_ID])).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(deps.models.requireOwnedModels)
      .toHaveBeenCalledWith([MODEL_ID, OTHER_MODEL_ID].sort(), USER_ID, LIBRARY_ID, tx);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty tag list', []],
    ['a blank tag', ['   ']],
    ['an oversized tag', ['x'.repeat(256)]],
  ])('should reject AI bulk previews containing %s before validation or persistence', async (
    _label,
    value,
  ) => {
    const deps = dependencies();
    const { tx, database } = previewDatabase({});
    const service = new AiProposalService(
      deps.models as never,
      deps.metadata as never,
      deps.collections as never,
      database as never,
      () => NOW,
    );

    await expect(service.createBulkPreview(USER_ID, LIBRARY_ID, {
      summary: 'Add tags',
      target: { scope: 'current_models' },
      metadataOperations: [{ fieldSlug: 'tags', action: 'add', value }],
    }, [MODEL_ID])).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(deps.models.requireOwnedModels).not.toHaveBeenCalled();
    expect(deps.metadata.validateBulkOperations).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('rolls back preview creation when cancellation arrives while the insert is in flight', async () => {
    const deps = dependencies();
    const controller = new AbortController();
    const insertChain = { values: vi.fn(), returning: vi.fn() };
    insertChain.values.mockReturnValue(insertChain);
    insertChain.returning.mockImplementation(async () => {
      controller.abort();
      return [{ id: PROPOSAL_ID }];
    });
    const { tx, database } = previewDatabase(insertChain);
    const service = new AiProposalService(
      deps.models as never,
      deps.metadata as never,
      deps.collections as never,
      database as never,
      () => NOW,
    );

    await expect(service.createPreview(USER_ID, LIBRARY_ID, {
      summary: 'Rename it',
      changes: [{
        type: 'update_model', modelId: MODEL_ID, modelName: 'Dragon', patch: { name: 'New name' },
      }],
    }, { signal: controller.signal, deadline: Date.now() + 10_000 }))
      .rejects.toMatchObject({ code: 'PROCESSING_FAILED' });
    expect(tx.insert).toHaveBeenCalledOnce();
  });

  it('rejects expired and replayed proposals before claiming them', async () => {
    for (const row of [
      proposalRow({ expiresAt: new Date(NOW.getTime() - 1), isExpired: true }),
      proposalRow({ status: 'applied' }),
    ]) {
      const deps = dependencies();
      const database = {
        select: vi.fn().mockReturnValue(selectChain([row])),
        update: vi.fn(),
      };
      const service = new AiProposalService(
        deps.models as never,
        deps.metadata as never,
        deps.collections as never,
        database as never,
        () => NOW,
      );
      await expect(service.apply(PROPOSAL_ID, USER_ID, LIBRARY_ID))
        .rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
      expect(database.update).not.toHaveBeenCalled();
    }
  });

  it('revalidates then atomically claims and applies only the stored payload', async () => {
    const deps = dependencies();
    const transactionUpdate = updateChain(true);
    const tx = { update: vi.fn().mockReturnValue(transactionUpdate) };
    const database = {
      select: vi.fn().mockReturnValue(selectChain([proposalRow()])),
      transaction: vi.fn().mockImplementation(async (callback) => callback(tx)),
    };
    const service = new AiProposalService(
      deps.models as never,
      deps.metadata as never,
      deps.collections as never,
      database as never,
      () => NOW,
    );

    const result = await service.apply(PROPOSAL_ID, USER_ID, LIBRARY_ID);

    expect(deps.models.lockOwnedModels).toHaveBeenCalledWith(
      [MODEL_ID], USER_ID, LIBRARY_ID, tx,
    );
    expect(deps.models.lockOwnedModels).toHaveBeenCalledBefore(deps.models.requireOwnedModel);
    expect(deps.models.requireOwnedModel).toHaveBeenCalledBefore(deps.models.updateModel);
    expect(deps.models.updateModel).toHaveBeenCalledWith(MODEL_ID, { name: 'Red Dragon' }, tx);
    expect(tx.update).toHaveBeenCalledTimes(2); // claim and applied transition share the mutation tx
    expect(result).toEqual({
      proposalId: PROPOSAL_ID,
      status: 'applied',
      changedModelIds: [MODEL_ID],
      changedImportSessionIds: [],
    });
  });

  it('rejects a concurrent apply when the conditional claim returns no row', async () => {
    const deps = dependencies();
    const tx = { update: vi.fn().mockReturnValue(updateChain(false)) };
    const database = {
      select: vi.fn().mockReturnValue(selectChain([proposalRow()])),
      transaction: vi.fn().mockImplementation(async (callback) => callback(tx)),
    };
    const service = new AiProposalService(
      deps.models as never,
      deps.metadata as never,
      deps.collections as never,
      database as never,
      () => NOW,
    );
    await expect(service.apply(PROPOSAL_ID, USER_ID, LIBRARY_ID))
      .rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
    expect(deps.models.updateModel).not.toHaveBeenCalled();
  });

  it('rolls the claim back to retryable pending state when a mutation fails', async () => {
    const deps = dependencies();
    const mutationError = new Error('metadata write failed');
    deps.models.updateModel.mockRejectedValue(mutationError);
    const claim = updateChain(true);
    const tx = { update: vi.fn().mockReturnValue(claim) };
    const database = {
      select: vi.fn().mockReturnValue(selectChain([proposalRow()])),
      transaction: vi.fn().mockImplementation(async (callback) => callback(tx)),
    };
    const service = new AiProposalService(
      deps.models as never,
      deps.metadata as never,
      deps.collections as never,
      database as never,
      () => NOW,
    );

    await expect(service.apply(PROPOSAL_ID, USER_ID, LIBRARY_ID)).rejects.toBe(mutationError);
    expect(database.transaction).toHaveBeenCalledOnce();
    expect(claim.set).toHaveBeenCalledWith({ status: 'applying' });
    expect(tx.update).toHaveBeenCalledOnce();
  });

  it('passes the same transaction to metadata and collection domain mutations', async () => {
    const deps = dependencies();
    const changes = [
      {
        type: 'set_metadata', modelId: MODEL_ID, modelName: 'Dragon',
        values: { artist: 'Maker' },
      },
      {
        type: 'update_collections', modelId: MODEL_ID, modelName: 'Dragon',
        addCollectionIds: [COLLECTION_ID], removeCollectionIds: [OTHER_COLLECTION_ID],
      },
    ];
    const tx = { update: vi.fn().mockReturnValue(updateChain(true)) };
    const database = {
      select: vi.fn().mockReturnValue(selectChain([proposalRow({ changes })])),
      transaction: vi.fn().mockImplementation(async (callback) => callback(tx)),
    };
    const service = new AiProposalService(
      deps.models as never,
      deps.metadata as never,
      deps.collections as never,
      database as never,
      () => NOW,
    );

    await service.apply(PROPOSAL_ID, USER_ID, LIBRARY_ID);
    expect(deps.metadata.setModelMetadata).toHaveBeenCalledWith(MODEL_ID, { artist: 'Maker' }, tx);
    expect(deps.collections.addModelsToCollection)
      .toHaveBeenCalledWith(COLLECTION_ID, [MODEL_ID], tx);
    expect(deps.collections.removeModelFromCollection)
      .toHaveBeenCalledWith(OTHER_COLLECTION_ID, MODEL_ID, tx);
  });

  it('should atomically apply idempotent bulk metadata and collection operations', async () => {
    const deps = dependencies();
    deps.metadata.getFieldBySlug.mockImplementation(async (slug: string) => ({
      slug,
      type: slug === 'tags' ? 'multi_enum' : 'text',
      isDefault: slug === 'tags',
    }));
    const modelIds = [MODEL_ID, OTHER_MODEL_ID];
    const metadataOperations = [{ fieldSlug: 'tags', action: 'add', value: ['terrain'] }];
    const collectionOperations = [
      { collectionId: COLLECTION_ID, action: 'add' },
      { collectionId: OTHER_COLLECTION_ID, action: 'remove' },
    ];
    const changes = [
      { type: 'bulk_metadata', modelIds, operations: metadataOperations },
      { type: 'bulk_collections', modelIds, operations: collectionOperations },
    ];
    const tx = { update: vi.fn().mockReturnValue(updateChain(true)) };
    const database = {
      select: vi.fn().mockReturnValue(selectChain([proposalRow({ changes })])),
      transaction: vi.fn().mockImplementation(async (callback) => callback(tx)),
    };
    const service = new AiProposalService(
      deps.models as never,
      deps.metadata as never,
      deps.collections as never,
      database as never,
      () => NOW,
    );

    const result = await service.apply(PROPOSAL_ID, USER_ID, LIBRARY_ID);

    expect(deps.models.lockOwnedModels)
      .toHaveBeenCalledWith(modelIds, USER_ID, LIBRARY_ID, tx);
    expect(deps.models.requireOwnedModels).toHaveBeenCalledTimes(1);
    expect(deps.metadata.bulkSetMetadata)
      .toHaveBeenCalledOnce();
    expect(deps.metadata.bulkSetMetadata)
      .toHaveBeenCalledWith(modelIds, metadataOperations, tx);
    expect(deps.collections.addModelsToCollection)
      .toHaveBeenCalledWith(COLLECTION_ID, modelIds, tx);
    expect(deps.collections.removeModelsFromCollection)
      .toHaveBeenCalledWith(OTHER_COLLECTION_ID, modelIds, tx);
    expect(deps.collections.removeModelFromCollection).not.toHaveBeenCalled();
    expect(result).toEqual({
      proposalId: PROPOSAL_ID,
      status: 'applied',
      changedModelIds: modelIds,
      changedImportSessionIds: [],
    });
  });

  it('should reject wrong-library bulk models under lock before claim or mutation', async () => {
    const deps = dependencies();
    const changes = [{
      type: 'bulk_metadata',
      modelIds: [MODEL_ID, OTHER_MODEL_ID],
      operations: [{ fieldSlug: 'artist', action: 'remove' }],
    }];
    deps.models.lockOwnedModels.mockRejectedValue(notFound('One or more models were not found'));
    const tx = { update: vi.fn().mockReturnValue(updateChain(true)) };
    const database = {
      select: vi.fn().mockReturnValue(selectChain([proposalRow({ changes })])),
      transaction: vi.fn().mockImplementation(async (callback) => callback(tx)),
    };
    const service = new AiProposalService(
      deps.models as never,
      deps.metadata as never,
      deps.collections as never,
      database as never,
      () => NOW,
    );

    await expect(service.apply(PROPOSAL_ID, USER_ID, LIBRARY_ID))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(tx.update).not.toHaveBeenCalled();
    expect(deps.metadata.bulkSetMetadata).not.toHaveBeenCalled();
    expect(deps.collections.addModelsToCollection).not.toHaveBeenCalled();
  });

  it('should validate, lock, and atomically apply a staged draft patch without touching models', async () => {
    const deps = dependencies();
    deps.metadata.getFieldBySlug.mockResolvedValue({ slug: 'source', type: 'text' });
    const changes = [{
      type: 'update_import_session',
      importSessionId: IMPORT_SESSION_ID,
      originalFilename: 'Maker - 2024 - Dragon.zip',
      expectedUpdatedAt: EXPECTED_UPDATED_AT,
      patch: {
        collectionId: COLLECTION_ID,
        metadata: { source: 'Fullmetal Alchemist' },
      },
    }];
    const tx = { update: vi.fn().mockReturnValue(updateChain(true)) };
    const database = {
      select: vi.fn().mockReturnValue(selectChain([proposalRow({ changes })])),
      transaction: vi.fn().mockImplementation(async (callback) => callback(tx)),
    };
    const service = new AiProposalService(
      deps.models as never,
      deps.metadata as never,
      deps.collections as never,
      database as never,
      () => NOW,
      deps.importSessions as never,
    );

    const result = await service.apply(PROPOSAL_ID, USER_ID, LIBRARY_ID);

    expect(deps.importSessions.lockOwnedReadyForReviewSessions)
      .toHaveBeenCalledWith([IMPORT_SESSION_ID], USER_ID, LIBRARY_ID, tx);
    expect(deps.importSessions.getOwnedReadyForReviewRow)
      .toHaveBeenCalledWith(IMPORT_SESSION_ID, USER_ID, LIBRARY_ID, tx);
    expect(deps.importSessions.lockOwnedReadyForReviewSessions)
      .toHaveBeenCalledBefore(deps.importSessions.getOwnedReadyForReviewRow);
    expect(deps.importSessions.getOwnedReadyForReviewRow)
      .toHaveBeenCalledBefore(deps.importSessions.updateDraftMetadata);
    expect(deps.importSessions.updateDraftMetadata)
      .toHaveBeenCalledWith(IMPORT_SESSION_ID, changes[0].patch, tx);
    expect(deps.collections.requireOwnedCollection)
      .toHaveBeenCalledWith(COLLECTION_ID, USER_ID, LIBRARY_ID, tx);
    expect(deps.models.lockOwnedModels).not.toHaveBeenCalled();
    expect(result).toEqual({
      proposalId: PROPOSAL_ID,
      status: 'applied',
      changedModelIds: [],
      changedImportSessionIds: [IMPORT_SESSION_ID],
    });
  });

  it('should reject a stale staged filename before preview persistence', async () => {
    const deps = dependencies();
    const { tx, database } = previewDatabase({});
    const service = new AiProposalService(
      deps.models as never,
      deps.metadata as never,
      deps.collections as never,
      database as never,
      () => NOW,
      deps.importSessions as never,
    );

    await expect(service.createPreview(USER_ID, LIBRARY_ID, {
      summary: 'Fill staged metadata',
      changes: [{
        type: 'update_import_session',
        importSessionId: IMPORT_SESSION_ID,
        originalFilename: 'stale.zip',
        expectedUpdatedAt: EXPECTED_UPDATED_AT,
        patch: { artist: 'Maker' },
      }],
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('should revalidate a staged filename at apply time before claiming or mutating', async () => {
    const deps = dependencies();
    const changes = [{
      type: 'update_import_session',
      importSessionId: IMPORT_SESSION_ID,
      originalFilename: 'Maker - 2024 - Dragon.zip',
      expectedUpdatedAt: EXPECTED_UPDATED_AT,
      patch: { artist: 'Maker' },
    }];
    deps.importSessions.getOwnedReadyForReviewRow.mockResolvedValue({
      id: IMPORT_SESSION_ID,
      originalFilename: 'Replacement.zip',
      updatedAt: new Date(EXPECTED_UPDATED_AT),
    });
    const tx = { update: vi.fn().mockReturnValue(updateChain(true)) };
    const database = {
      select: vi.fn().mockReturnValue(selectChain([proposalRow({ changes })])),
      transaction: vi.fn().mockImplementation(async (callback) => callback(tx)),
    };
    const service = new AiProposalService(
      deps.models as never,
      deps.metadata as never,
      deps.collections as never,
      database as never,
      () => NOW,
      deps.importSessions as never,
    );

    await expect(service.apply(PROPOSAL_ID, USER_ID, LIBRARY_ID))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(tx.update).not.toHaveBeenCalled();
    expect(deps.importSessions.updateDraftMetadata).not.toHaveBeenCalled();
  });

  it('should reject a staged proposal when updatedAt changed under the apply lock', async () => {
    const deps = dependencies();
    const changes = [{
      type: 'update_import_session',
      importSessionId: IMPORT_SESSION_ID,
      originalFilename: 'Maker - 2024 - Dragon.zip',
      expectedUpdatedAt: EXPECTED_UPDATED_AT,
      patch: { artist: 'Maker' },
    }];
    deps.importSessions.getOwnedReadyForReviewRow.mockResolvedValue({
      id: IMPORT_SESSION_ID,
      originalFilename: 'Maker - 2024 - Dragon.zip',
      updatedAt: new Date('2026-07-21T11:01:00.000Z'),
    });
    const tx = { update: vi.fn().mockReturnValue(updateChain(true)) };
    const database = {
      select: vi.fn().mockReturnValue(selectChain([proposalRow({ changes })])),
      transaction: vi.fn().mockImplementation(async (callback) => callback(tx)),
    };
    const service = new AiProposalService(
      deps.models as never,
      deps.metadata as never,
      deps.collections as never,
      database as never,
      () => NOW,
      deps.importSessions as never,
    );

    await expect(service.apply(PROPOSAL_ID, USER_ID, LIBRARY_ID))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(deps.importSessions.lockOwnedReadyForReviewSessions).toHaveBeenCalledOnce();
    expect(deps.importSessions.updateDraftMetadata).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown custom metadata', 'metadata'],
    ['unowned collection', 'collection'],
  ] as const)(
    'should reject %s before persisting a staged preview',
    async (_label, failureKind) => {
      const deps = dependencies();
      const expected = notFound('Referenced value is unavailable');
      if (failureKind === 'metadata') deps.metadata.getFieldBySlug.mockRejectedValue(expected);
      else deps.collections.requireOwnedCollection.mockRejectedValue(expected);
      const insertChain = { values: vi.fn(), returning: vi.fn() };
      insertChain.values.mockReturnValue(insertChain);
      insertChain.returning.mockResolvedValue([{ id: PROPOSAL_ID }]);
      const { tx, database } = previewDatabase(insertChain);
      const service = new AiProposalService(
        deps.models as never,
        deps.metadata as never,
        deps.collections as never,
        database as never,
        () => NOW,
        deps.importSessions as never,
      );

      await expect(service.createPreview(USER_ID, LIBRARY_ID, {
        summary: 'Fill staged metadata',
        changes: [{
          type: 'update_import_session',
          importSessionId: IMPORT_SESSION_ID,
          originalFilename: 'Maker - 2024 - Dragon.zip',
          expectedUpdatedAt: EXPECTED_UPDATED_AT,
          patch: failureKind === 'metadata'
            ? { metadata: { unknown: 'value' } }
            : { collectionId: COLLECTION_ID },
        }],
      })).rejects.toMatchObject({
        code: failureKind === 'metadata' ? 'VALIDATION_ERROR' : 'NOT_FOUND',
      });
      expect(tx.insert).not.toHaveBeenCalled();
    },
  );

  it('should stop before validation and mutation when a staged session is no longer reviewable', async () => {
    const deps = dependencies();
    const changes = [{
      type: 'update_import_session',
      importSessionId: IMPORT_SESSION_ID,
      originalFilename: 'Maker - 2024 - Dragon.zip',
      expectedUpdatedAt: EXPECTED_UPDATED_AT,
      patch: { artist: 'Maker' },
    }];
    deps.importSessions.lockOwnedReadyForReviewSessions.mockRejectedValue(
      Object.assign(new Error('Import session not found'), { code: 'NOT_FOUND', statusCode: 404 }),
    );
    const tx = { update: vi.fn().mockReturnValue(updateChain(true)) };
    const database = {
      select: vi.fn().mockReturnValue(selectChain([proposalRow({ changes })])),
      transaction: vi.fn().mockImplementation(async (callback) => callback(tx)),
    };
    const service = new AiProposalService(
      deps.models as never,
      deps.metadata as never,
      deps.collections as never,
      database as never,
      () => NOW,
      deps.importSessions as never,
    );

    await expect(service.apply(PROPOSAL_ID, USER_ID, LIBRARY_ID))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(deps.importSessions.getOwnedReadyForReviewRow).not.toHaveBeenCalled();
    expect(deps.importSessions.updateDraftMetadata).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });
});
