import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { errorHandler } from '../middleware/error-handler.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const LIBRARY_ID = '22222222-2222-4222-8222-222222222222';
const FILE_HASH = 'a'.repeat(64);

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(async (request: { user?: unknown }) => {
    request.user = { id: USER_ID };
  }),
  requireLibrary: vi.fn(async (request: { libraryId?: string }) => {
    request.libraryId = LIBRARY_ID;
  }),
  scanDuplicates: vi.fn(),
  markDuplicates: vi.fn(),
  markDuplicateFileGroup: vi.fn(),
  ignoreDuplicateFileGroup: vi.fn(),
  buildDuplicateScanResult: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('../middleware/library.js', () => ({ requireLibrary: mocks.requireLibrary }));
vi.mock('../services/duplicate-scanner.service.js', () => ({
  duplicateScannerService: {
    scanDuplicates: mocks.scanDuplicates,
    markDuplicates: mocks.markDuplicates,
    markDuplicateFileGroup: mocks.markDuplicateFileGroup,
    ignoreDuplicateFileGroup: mocks.ignoreDuplicateFileGroup,
  },
}));
vi.mock('../services/presenter.service.js', () => ({
  presenterService: { buildDuplicateScanResult: mocks.buildDuplicateScanResult },
}));

import { toolsRoutes } from './tools.js';

describe('Tools routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.scanDuplicates.mockResolvedValue({
      scannedModelCount: 2,
      scannedFileCount: 4,
      groups: [],
      fileGroups: [],
    });
    mocks.buildDuplicateScanResult.mockReturnValue({
      scannedModelCount: 2,
      scannedFileCount: 4,
      redundantModelCount: 1,
      redundantFileCount: 2,
      reclaimableBytes: 1024,
      fileReclaimableBytes: 512,
      groups: [],
      fileGroups: [],
    });
    mocks.markDuplicates.mockResolvedValue({ markedFileCount: 4, markedModelCount: 2 });
    mocks.markDuplicateFileGroup.mockResolvedValue({ markedFileCount: 2, markedModelCount: 1 });
    mocks.ignoreDuplicateFileGroup.mockResolvedValue({
      ignoredFileGroupCount: 1,
      ignoredModelGroupCount: 0,
    });
    app = Fastify();
    app.setErrorHandler(errorHandler);
    await app.register(toolsRoutes, { prefix: '/tools' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('requires authentication and the active library before scanning', async () => {
    const response = await app.inject({ method: 'GET', url: '/tools/duplicates' });

    expect(response.statusCode).toBe(200);
    expect(mocks.requireAuth).toHaveBeenCalledOnce();
    expect(mocks.requireLibrary).toHaveBeenCalledOnce();
    expect(mocks.requireAuth.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.requireLibrary.mock.invocationCallOrder[0]);
    expect(mocks.scanDuplicates).toHaveBeenCalledWith(LIBRARY_ID);
    expect(mocks.buildDuplicateScanResult).toHaveBeenCalledWith({
      scannedModelCount: 2,
      scannedFileCount: 4,
      groups: [],
      fileGroups: [],
    });
  });

  it('returns duplicate scan results in the standard envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/tools/duplicates' });

    expect(response.json()).toEqual({
      data: {
        scannedModelCount: 2,
        scannedFileCount: 4,
        redundantModelCount: 1,
        redundantFileCount: 2,
        reclaimableBytes: 1024,
        fileReclaimableBytes: 512,
        groups: [],
        fileGroups: [],
      },
      meta: null,
      errors: null,
    });
  });

  it('marks current duplicate candidates in the active library', async () => {
    const response = await app.inject({ method: 'POST', url: '/tools/duplicates/mark' });

    expect(response.statusCode).toBe(200);
    expect(mocks.requireAuth).toHaveBeenCalledOnce();
    expect(mocks.requireLibrary).toHaveBeenCalledOnce();
    expect(mocks.markDuplicates).toHaveBeenCalledWith(LIBRARY_ID);
    expect(response.json()).toEqual({
      data: { markedFileCount: 4, markedModelCount: 2 },
      meta: null,
      errors: null,
    });
  });

  it('marks one current file group in the active library', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/tools/duplicates/file-groups/${FILE_HASH}/mark`,
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.requireAuth).toHaveBeenCalledOnce();
    expect(mocks.requireLibrary).toHaveBeenCalledOnce();
    expect(mocks.markDuplicateFileGroup).toHaveBeenCalledWith(LIBRARY_ID, FILE_HASH);
    expect(response.json()).toEqual({
      data: { markedFileCount: 2, markedModelCount: 1 },
      meta: null,
      errors: null,
    });
  });

  it('ignores one current file group in the active library', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/tools/duplicates/file-groups/${FILE_HASH}/ignore`,
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.requireAuth).toHaveBeenCalledOnce();
    expect(mocks.requireLibrary).toHaveBeenCalledOnce();
    expect(mocks.ignoreDuplicateFileGroup).toHaveBeenCalledWith(LIBRARY_ID, FILE_HASH);
    expect(response.json()).toEqual({
      data: { ignoredFileGroupCount: 1, ignoredModelGroupCount: 0 },
      meta: null,
      errors: null,
    });
  });

  it.each(['short', 'A'.repeat(64), `${'a'.repeat(63)}g`])(
    'rejects invalid file-group hash %s',
    async (hash) => {
      const response = await app.inject({
        method: 'POST',
        url: `/tools/duplicates/file-groups/${hash}/mark`,
      });

      expect(response.statusCode).toBe(400);
      expect(mocks.markDuplicateFileGroup).not.toHaveBeenCalled();
      expect(response.json()).toEqual({
        data: null,
        meta: null,
        errors: [{
          code: 'VALIDATION_ERROR',
          field: 'hash',
          message: 'Hash must be a lowercase SHA-256 digest',
        }],
      });
    },
  );

  it('does not expose the former ignore-all action', async () => {
    const response = await app.inject({ method: 'POST', url: '/tools/duplicates/ignore' });

    expect(response.statusCode).toBe(404);
    expect(mocks.ignoreDuplicateFileGroup).not.toHaveBeenCalled();
  });
});
