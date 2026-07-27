import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MODEL_ID = '33333333-3333-4333-8333-333333333333';
const TARGET_LIBRARY_ID = '22222222-2222-4222-8222-222222222222';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(async (request: { user?: unknown }) => {
    request.user = { id: USER_ID };
  }),
  moveModel: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('../services/model.service.js', () => ({
  modelService: { moveModel: mocks.moveModel },
}));

import { modelRoutes } from './models.js';

describe('Model move route', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.moveModel.mockResolvedValue({
      modelId: MODEL_ID,
      libraryId: TARGET_LIBRARY_ID,
      removedCollectionCount: 2,
    });
    app = Fastify();
    await app.register(modelRoutes, { prefix: '/models' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('moves an owned model to the requested library', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/models/${MODEL_ID}/move`,
      payload: { targetLibraryId: TARGET_LIBRARY_ID },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.moveModel).toHaveBeenCalledWith(MODEL_ID, USER_ID, TARGET_LIBRARY_ID);
    expect(response.json()).toEqual({
      data: {
        modelId: MODEL_ID,
        libraryId: TARGET_LIBRARY_ID,
        removedCollectionCount: 2,
      },
      meta: null,
      errors: null,
    });
  });

  it('rejects an invalid destination before calling the service', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/models/${MODEL_ID}/move`,
      payload: { targetLibraryId: 'not-a-uuid' },
    });

    expect(response.statusCode).toBe(400);
    expect(mocks.moveModel).not.toHaveBeenCalled();
  });
});
