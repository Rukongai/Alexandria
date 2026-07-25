import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { errorHandler } from '../middleware/error-handler.js';
import { notFound } from '../utils/errors.js';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: async (request: { user: unknown }) => {
    request.user = { id: 'user-1' };
  },
}));

vi.mock('../middleware/library.js', () => ({
  requireLibrary: async (request: { libraryId: string | null }) => {
    request.libraryId = 'library-1';
  },
}));

vi.mock('../services/model.service.js', () => ({
  modelService: {
    requireOwnedModel: vi.fn(),
  },
}));

vi.mock('../services/model-folder-archive.service.js', () => ({
  modelFolderArchiveService: {
    compressFolder: vi.fn(),
  },
}));

import { modelRoutes } from './models.js';
import { modelService } from '../services/model.service.js';
import { modelFolderArchiveService } from '../services/model-folder-archive.service.js';

describe('model folder compression route', () => {
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

  it('returns the created archive and enforces user/library ownership', async () => {
    vi.mocked(modelFolderArchiveService.compressFolder).mockResolvedValue({
      archiveFileId: 'archive-file-1',
      archivePath: 'extras/parts.7z',
      sizeBytes: 2048,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/models/model-1/folders/compress',
      payload: { path: 'extras/parts' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      data: {
        archiveFileId: 'archive-file-1',
        archivePath: 'extras/parts.7z',
        sizeBytes: 2048,
      },
      meta: null,
      errors: null,
    });
    expect(modelService.requireOwnedModel).toHaveBeenCalledWith(
      'model-1',
      'user-1',
      'library-1',
    );
    expect(modelFolderArchiveService.compressFolder).toHaveBeenCalledWith(
      'model-1',
      'extras/parts',
    );
  });

  it.each([
    ['missing path', {}],
    ['empty path', { path: '' }],
    ['oversized path', { path: 'x'.repeat(1001) }],
  ])('rejects an invalid request with a validation envelope: %s', async (_label, payload) => {
    const response = await app.inject({
      method: 'POST',
      url: '/models/model-1/folders/compress',
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      data: null,
      meta: null,
      errors: [{ code: 'VALIDATION_ERROR' }],
    });
    expect(modelService.requireOwnedModel).not.toHaveBeenCalled();
    expect(modelFolderArchiveService.compressFolder).not.toHaveBeenCalled();
  });

  it('conceals a model outside the active user/library scope', async () => {
    vi.mocked(modelService.requireOwnedModel).mockRejectedValue(
      notFound('Model not found: model-1'),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/models/model-1/folders/compress',
      payload: { path: 'parts' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      data: null,
      meta: null,
      errors: [{ code: 'NOT_FOUND' }],
    });
    expect(modelFolderArchiveService.compressFolder).not.toHaveBeenCalled();
  });
});
