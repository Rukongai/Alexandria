import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const LIBRARY_ID = '22222222-2222-4222-8222-222222222222';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(async (request: { user?: unknown }) => {
    request.user = { id: USER_ID };
  }),
  requireLibrary: vi.fn(async (request: { libraryId?: string }) => {
    request.libraryId = LIBRARY_ID;
  }),
  scanDuplicates: vi.fn(),
  buildDuplicateScanResult: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('../middleware/library.js', () => ({ requireLibrary: mocks.requireLibrary }));
vi.mock('../services/duplicate-scanner.service.js', () => ({
  duplicateScannerService: { scanDuplicates: mocks.scanDuplicates },
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
      groups: [],
    });
    mocks.buildDuplicateScanResult.mockReturnValue({
      scannedModelCount: 2,
      redundantModelCount: 1,
      reclaimableBytes: 1024,
      groups: [],
    });
    app = Fastify();
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
      groups: [],
    });
  });

  it('returns duplicate scan results in the standard envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/tools/duplicates' });

    expect(response.json()).toEqual({
      data: {
        scannedModelCount: 2,
        redundantModelCount: 1,
        reclaimableBytes: 1024,
        groups: [],
      },
      meta: null,
      errors: null,
    });
  });
});
