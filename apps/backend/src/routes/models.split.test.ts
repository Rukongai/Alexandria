import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const LIBRARY_ID = '22222222-2222-4222-8222-222222222222';
const SOURCE_MODEL_ID = '33333333-3333-4333-8333-333333333333';
const NEW_MODEL_ID = '44444444-4444-4444-8444-444444444444';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(async (request: { user?: unknown }) => {
    request.user = { id: USER_ID };
  }),
  requireLibrary: vi.fn(async (request: { libraryId?: string }) => {
    request.libraryId = LIBRARY_ID;
  }),
  splitModelFolder: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('../middleware/library.js', () => ({ requireLibrary: mocks.requireLibrary }));
vi.mock('../services/model.service.js', () => ({
  modelService: {
    splitModelFolder: mocks.splitModelFolder,
  },
}));

import { modelRoutes } from './models.js';

describe('Model folder split route', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.splitModelFolder.mockResolvedValue({
      sourceModelId: SOURCE_MODEL_ID,
      newModelId: NEW_MODEL_ID,
      movedFileCount: 2,
    });
    app = Fastify();
    await app.register(modelRoutes, { prefix: '/models' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('should validate and delegate an owned library-scoped folder split', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/models/${SOURCE_MODEL_ID}/folders/split`,
      payload: {
        path: 'bundle/parts',
        name: 'Parts',
        metadataFieldSlugs: ['artist', 'tags'],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(mocks.requireAuth).toHaveBeenCalledOnce();
    expect(mocks.requireLibrary).toHaveBeenCalledOnce();
    expect(mocks.splitModelFolder).toHaveBeenCalledWith(
      SOURCE_MODEL_ID,
      'bundle/parts',
      'Parts',
      USER_ID,
      LIBRARY_ID,
      ['artist', 'tags'],
    );
    expect(response.json()).toEqual({
      data: {
        sourceModelId: SOURCE_MODEL_ID,
        newModelId: NEW_MODEL_ID,
        movedFileCount: 2,
      },
      meta: null,
      errors: null,
    });
  });

  it('should reject a blank model name before calling the service', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/models/${SOURCE_MODEL_ID}/folders/split`,
      payload: { path: 'bundle', name: '   ' },
    });

    expect(response.statusCode).toBe(400);
    expect(mocks.splitModelFolder).not.toHaveBeenCalled();
  });

  it('should default an omitted metadata selection to copying nothing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/models/${SOURCE_MODEL_ID}/folders/split`,
      payload: { path: 'bundle', name: 'Bundle' },
    });

    expect(response.statusCode).toBe(201);
    expect(mocks.splitModelFolder).toHaveBeenCalledWith(
      SOURCE_MODEL_ID,
      'bundle',
      'Bundle',
      USER_ID,
      LIBRARY_ID,
      [],
    );
  });

  it('should reject duplicate metadata selections before calling the service', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/models/${SOURCE_MODEL_ID}/folders/split`,
      payload: {
        path: 'bundle',
        name: 'Bundle',
        metadataFieldSlugs: ['artist', 'artist'],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(mocks.splitModelFolder).not.toHaveBeenCalled();
  });
});
