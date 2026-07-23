import { describe, expect, it, vi } from 'vitest';
import { BulkService } from './bulk.service.js';
import { notFound } from '../utils/errors.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const LIBRARY_ID = '22222222-2222-4222-8222-222222222222';
const MODEL_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_MODEL_ID = '44444444-4444-4444-8444-444444444444';
const COLLECTION_ID = '55555555-5555-4555-8555-555555555555';

function dependencies() {
  const tx = { kind: 'transaction' };
  return {
    tx,
    models: {
      lockOwnedModels: vi.fn().mockResolvedValue([]),
      listModelStoragePaths: vi.fn().mockResolvedValue([]),
      deleteModels: vi.fn().mockResolvedValue([]),
    },
    metadata: { bulkSetMetadata: vi.fn().mockResolvedValue(undefined) },
    collections: {
      lockOwnedCollection: vi.fn().mockResolvedValue(undefined),
      bulkCollectionOperation: vi.fn().mockResolvedValue(undefined),
    },
    storage: { delete: vi.fn().mockResolvedValue(undefined) },
    database: {
      transaction: vi.fn().mockImplementation(async (callback) => callback(tx)),
    },
  };
}

function serviceWith(deps: ReturnType<typeof dependencies>): BulkService {
  return new BulkService(
    deps.models as never,
    deps.metadata as never,
    deps.collections as never,
    deps.storage as never,
    deps.database as never,
  );
}

describe('BulkService scoped coordination', () => {
  it('should validate and apply metadata in one transaction', async () => {
    const deps = dependencies();
    const request = {
      modelIds: [OTHER_MODEL_ID, MODEL_ID],
      operations: [{ fieldSlug: 'artist', action: 'set' as const, value: 'Maker' }],
    };

    await serviceWith(deps).setMetadata(request, USER_ID, LIBRARY_ID);

    const sortedIds = [MODEL_ID, OTHER_MODEL_ID];
    expect(deps.models.lockOwnedModels)
      .toHaveBeenCalledWith(sortedIds, USER_ID, LIBRARY_ID, deps.tx);
    expect(deps.metadata.bulkSetMetadata)
      .toHaveBeenCalledWith(sortedIds, request.operations, deps.tx);
    expect(deps.models.lockOwnedModels)
      .toHaveBeenCalledBefore(deps.metadata.bulkSetMetadata);
    expect(deps.database.transaction).toHaveBeenCalledOnce();
  });

  it('should validate models and collection scope before delegating in one transaction', async () => {
    const deps = dependencies();
    const request = {
      modelIds: [OTHER_MODEL_ID, MODEL_ID],
      action: 'move' as const,
      collectionId: COLLECTION_ID,
    };

    await serviceWith(deps).updateCollection(request, USER_ID, LIBRARY_ID);

    const canonicalRequest = { ...request, modelIds: [MODEL_ID, OTHER_MODEL_ID] };
    expect(deps.models.lockOwnedModels)
      .toHaveBeenCalledWith(canonicalRequest.modelIds, USER_ID, LIBRARY_ID, deps.tx);
    expect(deps.collections.lockOwnedCollection)
      .toHaveBeenCalledWith(COLLECTION_ID, USER_ID, LIBRARY_ID, deps.tx);
    expect(deps.collections.bulkCollectionOperation)
      .toHaveBeenCalledWith(canonicalRequest, deps.tx);
    expect(deps.models.lockOwnedModels)
      .toHaveBeenCalledBefore(deps.collections.lockOwnedCollection);
    expect(deps.collections.lockOwnedCollection)
      .toHaveBeenCalledBefore(deps.collections.bulkCollectionOperation);
  });

  it.each([
    ['metadata', 'setMetadata'],
    ['collection', 'updateCollection'],
    ['delete', 'deleteModels'],
  ] as const)('should reject unowned or wrong-library model IDs before %s mutation', async (
    _label,
    method,
  ) => {
    const deps = dependencies();
    deps.models.lockOwnedModels.mockRejectedValue(notFound('One or more models were not found'));
    const service = serviceWith(deps);
    const operation = method === 'setMetadata'
      ? service.setMetadata({
        modelIds: [MODEL_ID],
        operations: [{ fieldSlug: 'artist', action: 'remove' }],
      }, USER_ID, LIBRARY_ID)
      : method === 'updateCollection'
        ? service.updateCollection({
          modelIds: [MODEL_ID], action: 'add', collectionId: COLLECTION_ID,
        }, USER_ID, LIBRARY_ID)
        : service.deleteModels({ modelIds: [MODEL_ID] }, USER_ID, LIBRARY_ID);

    await expect(operation).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(deps.metadata.bulkSetMetadata).not.toHaveBeenCalled();
    expect(deps.collections.lockOwnedCollection).not.toHaveBeenCalled();
    expect(deps.collections.bulkCollectionOperation).not.toHaveBeenCalled();
    expect(deps.models.listModelStoragePaths).not.toHaveBeenCalled();
    expect(deps.models.deleteModels).not.toHaveBeenCalled();
    expect(deps.storage.delete).not.toHaveBeenCalled();
  });

  it('should reject a wrong-library collection before collection mutation', async () => {
    const deps = dependencies();
    deps.collections.lockOwnedCollection.mockRejectedValue(notFound('Collection not found'));

    await expect(serviceWith(deps).updateCollection({
      modelIds: [MODEL_ID], action: 'add', collectionId: COLLECTION_ID,
    }, USER_ID, LIBRARY_ID)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(deps.collections.bulkCollectionOperation).not.toHaveBeenCalled();
  });

  it('should delete transactionally then best-effort clean only validated storage paths', async () => {
    const deps = dependencies();
    const sortedIds = [MODEL_ID, OTHER_MODEL_ID];
    deps.models.listModelStoragePaths.mockResolvedValue([
      'models/dragon/model.stl',
      'models/castle/cover.webp',
    ]);
    deps.models.deleteModels.mockResolvedValue([OTHER_MODEL_ID, MODEL_ID]);
    deps.storage.delete
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('storage unavailable'));

    const result = await serviceWith(deps).deleteModels(
      { modelIds: [OTHER_MODEL_ID, MODEL_ID] },
      USER_ID,
      LIBRARY_ID,
    );

    expect(deps.models.lockOwnedModels)
      .toHaveBeenCalledWith(sortedIds, USER_ID, LIBRARY_ID, deps.tx);
    expect(deps.models.listModelStoragePaths).toHaveBeenCalledWith(sortedIds, deps.tx);
    expect(deps.models.deleteModels).toHaveBeenCalledWith(sortedIds, deps.tx);
    expect(deps.models.lockOwnedModels)
      .toHaveBeenCalledBefore(deps.models.listModelStoragePaths);
    expect(deps.models.listModelStoragePaths)
      .toHaveBeenCalledBefore(deps.models.deleteModels);
    expect(deps.models.deleteModels).toHaveBeenCalledBefore(deps.storage.delete);
    expect(deps.storage.delete.mock.calls).toEqual([
      ['models/dragon/model.stl'],
      ['models/castle/cover.webp'],
    ]);
    expect(result).toEqual({ deletedCount: 2, deletedIds: sortedIds });
  });
});
