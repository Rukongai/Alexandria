import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../middleware/error-handler.js';
import { notFound } from '../utils/errors.js';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(async (request: { user?: unknown }) => {
    request.user = { id: 'user-1' };
  }),
  requireLibrary: vi.fn(async (request: { libraryId?: string }) => {
    request.libraryId = 'library-1';
  }),
  list: vi.fn(),
  download: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('../middleware/library.js', () => ({ requireLibrary: mocks.requireLibrary }));
vi.mock('../services/archive-browser.service.js', () => ({
  archiveBrowserService: { list: mocks.list, download: mocks.download },
}));

import { modelRoutes } from './models.js';

describe('model archive browser routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify();
    app.decorateRequest('user', null);
    app.decorateRequest('libraryId', null);
    app.setErrorHandler(errorHandler);
    await app.register(modelRoutes, { prefix: '/models' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns a safe archive manifest in the active library scope', async () => {
    mocks.list.mockResolvedValue({
      entries: [{ path: 'parts/body.stl', sizeBytes: 123, isDirectory: false }],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/models/model-1/files/file-1/archive',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: { entries: [{ path: 'parts/body.stl', sizeBytes: 123, isDirectory: false }] },
      meta: null,
      errors: null,
    });
    expect(mocks.list).toHaveBeenCalledWith('model-1', 'file-1', 'library-1');
  });

  it('streams an exact archive entry as an attachment', async () => {
    mocks.download.mockResolvedValue({
      filename: 'body.stl',
      sizeBytes: 4,
      stream: Readable.from([Buffer.from('mesh')]),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/models/model-1/files/file-1/archive/download?path=parts%2Fbody.stl',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('mesh');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="body.stl"; filename*=UTF-8''${encodeURIComponent('body.stl')}`,
    );
    expect(mocks.download).toHaveBeenCalledWith(
      'model-1',
      'file-1',
      'library-1',
      'parts/body.stl',
    );
  });

  it('uses an ASCII fallback and UTF-8 filename parameter for Unicode entry names', async () => {
    mocks.download.mockResolvedValue({
      filename: '日本.stl',
      sizeBytes: 4,
      stream: Readable.from([Buffer.from('mesh')]),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/models/model-1/files/file-1/archive/download?path=%E6%97%A5%E6%9C%AC.stl',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="__.stl"; filename*=UTF-8''${encodeURIComponent('日本.stl')}`,
    );
  });

  it('rejects an invalid requested entry path before delegating', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/models/model-1/files/file-1/archive/download',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ errors: [{ code: 'VALIDATION_ERROR' }] });
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('conceals archives outside the active library', async () => {
    mocks.list.mockRejectedValue(notFound('Model not found: model-1'));

    const response = await app.inject({
      method: 'GET',
      url: '/models/model-1/files/file-1/archive',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ errors: [{ code: 'NOT_FOUND' }] });
  });
});
