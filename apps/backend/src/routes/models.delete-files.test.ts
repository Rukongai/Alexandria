import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const LIBRARY_ID = '22222222-2222-4222-8222-222222222222';
const MODEL_ID = '33333333-3333-4333-8333-333333333333';
const FILE_IDS = [
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
];

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(async (request: { user?: unknown }) => {
    request.user = { id: USER_ID };
  }),
  requireLibrary: vi.fn(async (request: { libraryId?: string }) => {
    request.libraryId = LIBRARY_ID;
  }),
  requireOwnedModel: vi.fn(),
  deleteModelFiles: vi.fn(),
  buildModelDetail: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('../middleware/library.js', () => ({ requireLibrary: mocks.requireLibrary }));
vi.mock('../services/model.service.js', () => ({
  modelService: {
    requireOwnedModel: mocks.requireOwnedModel,
    deleteModelFiles: mocks.deleteModelFiles,
  },
}));
vi.mock('../services/presenter.service.js', () => ({
  presenterService: { buildModelDetail: mocks.buildModelDetail },
}));

import { modelRoutes } from './models.js';

describe('Model selected-file delete route', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.buildModelDetail.mockResolvedValue({ id: MODEL_ID, fileCount: 1 });
    app = Fastify();
    await app.register(modelRoutes, { prefix: '/models' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('validates and delegates all selected files as one operation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/models/${MODEL_ID}/files/delete`,
      payload: { fileIds: FILE_IDS },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.requireOwnedModel).toHaveBeenCalledWith(MODEL_ID, USER_ID, LIBRARY_ID);
    expect(mocks.deleteModelFiles).toHaveBeenCalledOnce();
    expect(mocks.deleteModelFiles).toHaveBeenCalledWith(MODEL_ID, FILE_IDS);
    expect(response.json()).toEqual({
      data: { id: MODEL_ID, fileCount: 1 },
      meta: null,
      errors: null,
    });
  });

  it('rejects duplicate file IDs before deleting anything', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/models/${MODEL_ID}/files/delete`,
      payload: { fileIds: [FILE_IDS[0], FILE_IDS[0]] },
    });

    expect(response.statusCode).toBe(400);
    expect(mocks.deleteModelFiles).not.toHaveBeenCalled();
  });

  it('rejects an empty selection before deleting anything', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/models/${MODEL_ID}/files/delete`,
      payload: { fileIds: [] },
    });

    expect(response.statusCode).toBe(400);
    expect(mocks.deleteModelFiles).not.toHaveBeenCalled();
  });

  it('rejects selections larger than the supported batch size', async () => {
    const fileIds = Array.from(
      { length: 501 },
      (_, index) => `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    );
    const response = await app.inject({
      method: 'POST',
      url: `/models/${MODEL_ID}/files/delete`,
      payload: { fileIds },
    });

    expect(response.statusCode).toBe(400);
    expect(mocks.deleteModelFiles).not.toHaveBeenCalled();
  });
});
