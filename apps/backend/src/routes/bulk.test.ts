import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const LIBRARY_ID = '22222222-2222-4222-8222-222222222222';
const MODEL_ID = '33333333-3333-4333-8333-333333333333';
const COLLECTION_ID = '44444444-4444-4444-8444-444444444444';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(async (request: { user?: unknown }) => {
    request.user = { id: USER_ID };
  }),
  requireLibrary: vi.fn(async (request: { libraryId?: string }) => {
    request.libraryId = LIBRARY_ID;
  }),
  setMetadata: vi.fn(),
  updateCollection: vi.fn(),
  deleteModels: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('../middleware/library.js', () => ({ requireLibrary: mocks.requireLibrary }));
vi.mock('../services/bulk.service.js', () => ({
  bulkService: {
    setMetadata: mocks.setMetadata,
    updateCollection: mocks.updateCollection,
    deleteModels: mocks.deleteModels,
  },
}));

import { bulkRoutes } from './bulk.js';

describe('Bulk route middleware and delegation contract', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.setMetadata.mockResolvedValue(undefined);
    mocks.updateCollection.mockResolvedValue(undefined);
    mocks.deleteModels.mockResolvedValue({ deletedCount: 1, deletedIds: [MODEL_ID] });
    app = Fastify();
    await app.register(bulkRoutes, { prefix: '/bulk' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it.each([
    [
      '/bulk/metadata',
      {
        modelIds: [MODEL_ID],
        operations: [{ fieldSlug: 'artist', action: 'set', value: 'Maker' }],
      },
      'setMetadata',
    ],
    [
      '/bulk/collection',
      { modelIds: [MODEL_ID], action: 'add', collectionId: COLLECTION_ID },
      'updateCollection',
    ],
    [
      '/bulk/delete',
      { modelIds: [MODEL_ID] },
      'deleteModels',
    ],
  ] as const)(
    'should require authentication and active library scope before delegating %s',
    async (url, payload, method) => {
      const response = await app.inject({ method: 'POST', url, payload });

      expect(response.statusCode).toBe(200);
      expect(mocks.requireAuth).toHaveBeenCalledOnce();
      expect(mocks.requireLibrary).toHaveBeenCalledOnce();
      expect(mocks.requireAuth.mock.invocationCallOrder[0])
        .toBeLessThan(mocks.requireLibrary.mock.invocationCallOrder[0]);
      expect(mocks[method]).toHaveBeenCalledWith(payload, USER_ID, LIBRARY_ID);
    },
  );

  it('should return the coordinator delete result in the API envelope', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/bulk/delete',
      payload: { modelIds: [MODEL_ID] },
    });

    expect(response.json()).toEqual({
      data: { deletedCount: 1, deletedIds: [MODEL_ID] },
      meta: null,
      errors: null,
    });
  });
});
