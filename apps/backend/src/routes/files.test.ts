import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  retrieveStream: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  db: { select: mocks.select },
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: async (request: { user: unknown }) => {
    request.user = { id: 'user-1' };
  },
}));

vi.mock('../services/storage.service.js', () => ({
  storageService: { retrieveStream: mocks.retrieveStream },
}));

import { fileRoutes } from './files.js';

function returnRows(rows: unknown[]): void {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  mocks.select.mockReturnValueOnce({ from });
}

describe('file routes HTTP caching', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.retrieveStream.mockImplementation(async () => Readable.from([Buffer.from('payload')]));
    app = Fastify();
    app.decorateRequest('user', null);
    await app.register(fileRoutes, { prefix: '/files' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('serves immutable thumbnails with a stable quoted ETag and one-year private caching', async () => {
    const thumbnailId = '11111111-1111-4111-8111-111111111111';
    returnRows([{ storagePath: `thumbnails/model-1/${thumbnailId}.webp` }]);

    const response = await app.inject({
      method: 'GET',
      url: `/files/thumbnails/${thumbnailId}.webp`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe(`"${thumbnailId}"`);
    expect(response.headers['cache-control']).toBe(
      'private, max-age=31536000, immutable',
    );
    expect(response.headers.vary).toBe('Cookie');
    expect(response.headers['content-type']).toContain('image/webp');
    expect(mocks.retrieveStream).toHaveBeenCalledWith(
      `thumbnails/model-1/${thumbnailId}.webp`,
    );
  });

  it.each([
    '"11111111-1111-4111-8111-111111111111"',
    '"unrelated", W/"11111111-1111-4111-8111-111111111111"',
    '*',
  ])('returns a thumbnail 304 before storage retrieval for If-None-Match %j', async (header) => {
    const thumbnailId = '11111111-1111-4111-8111-111111111111';
    returnRows([{ storagePath: `thumbnails/model-1/${thumbnailId}.webp` }]);

    const response = await app.inject({
      method: 'GET',
      url: `/files/thumbnails/${thumbnailId}.webp`,
      headers: { 'if-none-match': header },
    });

    expect(response.statusCode).toBe(304);
    expect(response.headers.etag).toBe(`"${thumbnailId}"`);
    expect(response.headers['cache-control']).toBe(
      'private, max-age=31536000, immutable',
    );
    expect(response.headers.vary).toBe('Cookie');
    expect(response.body).toBe('');
    expect(mocks.retrieveStream).not.toHaveBeenCalled();
  });

  it('serves model files with a strong hash ETag and persisted content length', async () => {
    const hash = 'a'.repeat(64);
    returnRows([{
      storagePath: 'models/model-1/folder/part.stl',
      filename: 'part.stl',
      mimeType: 'model/stl',
      hash,
      sizeBytes: 1234,
    }]);

    const response = await app.inject({
      method: 'GET',
      url: '/files/models/model-1/folder/part.stl',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe(`"${hash}"`);
    expect(response.headers['content-length']).toBe('1234');
    expect(response.headers['cache-control']).toBe('private, max-age=86400');
    expect(response.headers.vary).toBe('Cookie');
    expect(response.headers['content-type']).toContain('model/stl');
    expect(mocks.retrieveStream).toHaveBeenCalledWith('models/model-1/folder/part.stl');
  });

  it('returns a model-file 304 for a weak ETag in a comma list before storage retrieval', async () => {
    const hash = 'b'.repeat(64);
    returnRows([{
      storagePath: 'models/model-1/part.stl',
      filename: 'part.stl',
      mimeType: 'model/stl',
      hash,
      sizeBytes: 1234,
    }]);

    const response = await app.inject({
      method: 'GET',
      url: '/files/models/model-1/part.stl',
      headers: { 'if-none-match': `"old", W/"${hash}", "other"` },
    });

    expect(response.statusCode).toBe(304);
    expect(response.headers.etag).toBe(`"${hash}"`);
    expect(response.headers['cache-control']).toBe('private, max-age=86400');
    expect(response.headers.vary).toBe('Cookie');
    expect(response.body).toBe('');
    expect(mocks.retrieveStream).not.toHaveBeenCalled();
  });

  it('retrieves a model file when If-None-Match does not match', async () => {
    returnRows([{
      storagePath: 'models/model-1/part.stl',
      filename: 'part.stl',
      mimeType: 'model/stl',
      hash: 'c'.repeat(64),
      sizeBytes: 7,
    }]);

    const response = await app.inject({
      method: 'GET',
      url: '/files/models/model-1/part.stl',
      headers: { 'if-none-match': 'W/"different"' },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.retrieveStream).toHaveBeenCalledTimes(1);
  });

  it.each([
    'w/"11111111-1111-4111-8111-111111111111"',
    'W/ "11111111-1111-4111-8111-111111111111"',
  ])('does not accept malformed weak entity tag %j', async (header) => {
    const thumbnailId = '11111111-1111-4111-8111-111111111111';
    returnRows([{ storagePath: `thumbnails/model-1/${thumbnailId}.webp` }]);

    const response = await app.inject({
      method: 'GET',
      url: `/files/thumbnails/${thumbnailId}.webp`,
      headers: { 'if-none-match': header },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.retrieveStream).toHaveBeenCalledTimes(1);
  });
});
