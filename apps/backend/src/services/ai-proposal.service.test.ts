import { describe, expect, it, vi } from 'vitest';
import { AiProposalService } from './ai-proposal.service.js';

const PROPOSAL_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const LIBRARY_ID = '33333333-3333-4333-8333-333333333333';
const MODEL_ID = '44444444-4444-4444-8444-444444444444';
const COLLECTION_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_COLLECTION_ID = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-07-21T12:00:00.000Z');

function dependencies() {
  return {
    models: {
      requireOwnedModel: vi.fn().mockResolvedValue({ id: MODEL_ID, name: 'Dragon' }),
      lockOwnedModels: vi.fn().mockResolvedValue([{ id: MODEL_ID, name: 'Dragon' }]),
      getModelFiles: vi.fn().mockResolvedValue([]),
      updateModel: vi.fn().mockResolvedValue({ id: MODEL_ID }),
    },
    metadata: {
      getFieldBySlug: vi.fn().mockResolvedValue({ slug: 'artist' }),
      setModelMetadata: vi.fn().mockResolvedValue(undefined),
    },
    collections: {
      requireOwnedCollection: vi.fn().mockResolvedValue(undefined),
      getCollectionById: vi.fn().mockImplementation(async (id: string) => ({ id, name: `Collection ${id}` })),
      addModelsToCollection: vi.fn().mockResolvedValue(undefined),
      removeModelFromCollection: vi.fn().mockResolvedValue(undefined),
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
});
