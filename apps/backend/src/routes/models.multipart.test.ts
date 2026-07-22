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

vi.mock('../services/upload.service.js', () => ({
  uploadService: {
    initUpload: vi.fn(),
    receiveChunk: vi.fn(),
    assembleFile: vi.fn(),
    assembleFiles: vi.fn(),
    abortUpload: vi.fn(),
  },
}));

vi.mock('../services/ingestion.service.js', () => ({
  ingestionService: {
    handleScan: vi.fn(),
    handleMultipartScan: vi.fn(),
  },
}));

import { modelRoutes } from './models.js';
import { uploadService } from '../services/upload.service.js';
import { ingestionService } from '../services/ingestion.service.js';

const FIRST_UPLOAD_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_UPLOAD_ID = '22222222-2222-4222-8222-222222222222';

function uploadId(index: number): string {
  return `${index.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
}

describe('multipart archive upload routes', () => {
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

  it.each([
    'model.zip',
    'model.RAR',
    'model.7z',
    'model.tar.gz',
    'model.TGZ',
    'dragon.z01',
    'dragon.Z99',
    'dragon.zip.001',
    'dragon.ZIP.999',
  ])('accepts supported archive member %s at multipart init', async (filename) => {
    vi.mocked(uploadService.initUpload).mockReturnValue({
      uploadId: FIRST_UPLOAD_ID,
      expiresAt: '2026-07-22T00:00:00.000Z',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/models/upload/multipart/init',
      payload: { filename, totalSize: 10, totalChunks: 1 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      data: {
        uploadId: FIRST_UPLOAD_ID,
        expiresAt: '2026-07-22T00:00:00.000Z',
      },
      meta: null,
      errors: null,
    });
    expect(uploadService.initUpload).toHaveBeenCalledWith(filename, 10, 1, 'user-1');
  });

  it.each([
    'notes.txt',
    'dragon.z00',
    'dragon.z100',
    'dragon.zip.000',
    'dragon.zip.1000',
    'dragon.zip.001.bak',
  ])('rejects unrelated or out-of-range member %s at multipart init', async (filename) => {
    const response = await app.inject({
      method: 'POST',
      url: '/models/upload/multipart/init',
      payload: { filename, totalSize: 10, totalChunks: 1 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      data: null,
      meta: null,
      errors: [{ code: 'VALIDATION_ERROR' }],
    });
    expect(uploadService.initUpload).not.toHaveBeenCalled();
  });

  it('assembles an owned group and returns one scan session', async () => {
    const files = [
      { tempFilePath: '/tmp/dragon.z01', originalFilename: 'dragon.z01' },
      { tempFilePath: '/tmp/dragon.zip', originalFilename: 'dragon.zip' },
    ];
    vi.mocked(uploadService.assembleFiles).mockResolvedValue(files);
    vi.mocked(ingestionService.handleMultipartScan).mockResolvedValue({ sessionId: 'session-1' });

    const response = await app.inject({
      method: 'POST',
      url: '/models/upload/multipart/complete',
      payload: { uploadIds: [FIRST_UPLOAD_ID, SECOND_UPLOAD_ID], mode: 'split' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      data: { sessionId: 'session-1' },
      meta: null,
      errors: null,
    });
    expect(uploadService.assembleFiles).toHaveBeenCalledWith(
      [FIRST_UPLOAD_ID, SECOND_UPLOAD_ID],
      'user-1',
    );
    expect(ingestionService.handleMultipartScan).toHaveBeenCalledWith(
      files,
      'split',
      'user-1',
      'library-1',
    );
    expect(ingestionService.handleMultipartScan).toHaveBeenCalledOnce();
  });

  it('accepts the maximum of 100 unique upload IDs', async () => {
    const uploadIds = Array.from({ length: 100 }, (_, index) => uploadId(index + 1));
    const files = uploadIds.map((id, index) => ({
      tempFilePath: `/tmp/${id}.zip`,
      originalFilename: `archive-${index + 1}.zip`,
    }));
    vi.mocked(uploadService.assembleFiles).mockResolvedValue(files);
    vi.mocked(ingestionService.handleMultipartScan).mockResolvedValue({ sessionId: 'session-max' });

    const response = await app.inject({
      method: 'POST',
      url: '/models/upload/multipart/complete',
      payload: { uploadIds, mode: 'combine' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().data).toEqual({ sessionId: 'session-max' });
    expect(uploadService.assembleFiles).toHaveBeenCalledWith(uploadIds, 'user-1');
    expect(ingestionService.handleMultipartScan).toHaveBeenCalledOnce();
  });

  it.each([
    ['fewer than two IDs', [FIRST_UPLOAD_ID], 'combine'],
    ['more than 100 IDs', Array.from({ length: 101 }, (_, index) => uploadId(index + 1)), 'combine'],
    ['an unsupported mode', [FIRST_UPLOAD_ID, SECOND_UPLOAD_ID], 'automatic'],
  ])('rejects %s before assembling uploads', async (_label, uploadIds, mode) => {
    const response = await app.inject({
      method: 'POST',
      url: '/models/upload/multipart/complete',
      payload: { uploadIds, mode },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      data: null,
      meta: null,
      errors: [{ code: 'VALIDATION_ERROR' }],
    });
    expect(uploadService.assembleFiles).not.toHaveBeenCalled();
    expect(ingestionService.handleMultipartScan).not.toHaveBeenCalled();
  });

  it('rejects duplicate upload IDs before calling the service', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/models/upload/multipart/complete',
      payload: { uploadIds: [FIRST_UPLOAD_ID, FIRST_UPLOAD_ID], mode: 'combine' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().errors[0].code).toBe('VALIDATION_ERROR');
    expect(uploadService.assembleFiles).not.toHaveBeenCalled();
  });

  it('does not expose or scan another user\'s upload session', async () => {
    vi.mocked(uploadService.assembleFiles).mockRejectedValue(
      notFound(`Upload session ${SECOND_UPLOAD_ID} not found`),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/models/upload/multipart/complete',
      payload: { uploadIds: [FIRST_UPLOAD_ID, SECOND_UPLOAD_ID], mode: 'combine' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().errors[0].code).toBe('NOT_FOUND');
    expect(ingestionService.handleMultipartScan).not.toHaveBeenCalled();
  });

  it('aborts an authenticated upload session', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/models/upload/${FIRST_UPLOAD_ID}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: null, meta: null, errors: null });
    expect(uploadService.abortUpload).toHaveBeenCalledWith(FIRST_UPLOAD_ID, 'user-1');
  });

  it('does not expose another user\'s upload through abort', async () => {
    vi.mocked(uploadService.abortUpload).mockImplementation(() => {
      throw notFound(`Upload session ${FIRST_UPLOAD_ID} not found`);
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/models/upload/${FIRST_UPLOAD_ID}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      data: null,
      meta: null,
      errors: [{ code: 'NOT_FOUND' }],
    });
    expect(uploadService.abortUpload).toHaveBeenCalledWith(FIRST_UPLOAD_ID, 'user-1');
  });
});
