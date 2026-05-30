import { pipeline } from 'node:stream/promises';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Readable } from 'node:stream';
import type {
  ImportConfig,
  ModelSearchParams,
  UpdateModelRequest,
  BatchUploadMetadata,
} from '@alexandria/shared';
import {
  importConfigSchema,
  modelSearchParamsSchema,
  updateModelSchema,
  uploadInitSchema,
  chunkIndexParamsSchema,
  uploadCompleteParamsSchema,
  commitImportSessionSchema,
  importSessionIdParamsSchema,
} from '@alexandria/shared';
import { requireAuth } from '../middleware/auth.js';
import { requireLibrary } from '../middleware/library.js';
import { validate } from '../middleware/validate.js';
import { detectArchiveExtension } from '../utils/archive.js';
import { ingestionService } from '../services/ingestion.service.js';
import { importSessionService } from '../services/import-session.service.js';
import { modelService } from '../services/model.service.js';
import { searchService } from '../services/search.service.js';
import { presenterService } from '../services/presenter.service.js';
import { storageService } from '../services/storage.service.js';
import { uploadService } from '../services/upload.service.js';
import { validationError } from '../utils/errors.js';

export async function modelRoutes(app: FastifyInstance): Promise<void> {
  // GET / — browse/search models with filters, sorting, pagination
  app.get(
    '/',
    { preHandler: [requireAuth, requireLibrary] },
    async (request, reply) => {
      const rawQuery = request.query as Record<string, unknown>;

      // Extract meta_* keys into a metadataFilters record (frontend uses meta_ prefix)
      const metadataFilters: Record<string, string> = {};
      for (const [key, val] of Object.entries(rawQuery)) {
        if (key.startsWith('meta_') && typeof val === 'string') {
          const fieldSlug = key.slice('meta_'.length);
          if (fieldSlug) {
            metadataFilters[fieldSlug] = val;
          }
        }
      }

      // Parse and validate query params
      const parseResult = modelSearchParamsSchema.safeParse({
        ...rawQuery,
        ...(Object.keys(metadataFilters).length > 0 ? { metadataFilters } : {}),
      });

      if (!parseResult.success) {
        const firstIssue = parseResult.error.issues[0];
        const field = firstIssue?.path.join('.') ?? undefined;
        const message = firstIssue?.message ?? 'Validation failed';
        throw validationError(message, field);
      }

      const params = parseResult.data as ModelSearchParams;
      const result = await searchService.searchModels(params, request.libraryId!);

      return reply.status(200).send({
        data: result.models,
        meta: {
          total: result.total,
          cursor: result.cursor,
          pageSize: result.pageSize,
        },
        errors: null,
      });
    },
  );

  // POST /upload/init — initiate a chunked upload session
  app.post(
    '/upload/init',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const parseResult = uploadInitSchema.safeParse(request.body);
      if (!parseResult.success) {
        const firstIssue = parseResult.error.issues[0];
        throw validationError(
          firstIssue?.message ?? 'Validation failed',
          firstIssue?.path.join('.') ?? undefined,
        );
      }

      const { filename, totalSize, totalChunks } = parseResult.data;
      const userId = request.user!.id;

      if (!detectArchiveExtension(filename)) {
        throw validationError('Only .zip, .rar, .7z, and .tar.gz archives are supported');
      }

      const result = uploadService.initUpload(filename, totalSize, totalChunks, userId);
      return reply.status(201).send({ data: result, meta: null, errors: null });
    },
  );

  // PUT /upload/:uploadId/chunk/:index — receive a single chunk
  app.put(
    '/upload/:uploadId/chunk/:index',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const parseResult = chunkIndexParamsSchema.safeParse(request.params);
      if (!parseResult.success) {
        const firstIssue = parseResult.error.issues[0];
        throw validationError(
          firstIssue?.message ?? 'Validation failed',
          firstIssue?.path.join('.') ?? undefined,
        );
      }

      const { uploadId, index } = parseResult.data;
      const userId = request.user!.id;

      const result = await uploadService.receiveChunk(
        uploadId,
        index,
        request.body as Readable,
        userId,
      );
      return reply.status(200).send({ data: result, meta: null, errors: null });
    },
  );

  // POST /upload/:uploadId/complete — assemble chunks and start ingestion
  // requireLibrary is mandatory: libraryId comes ONLY from request.libraryId,
  // never from query or body parameters.
  app.post(
    '/upload/:uploadId/complete',
    { preHandler: [requireAuth, requireLibrary] },
    async (request, reply) => {
      const parseResult = uploadCompleteParamsSchema.safeParse(request.params);
      if (!parseResult.success) {
        const firstIssue = parseResult.error.issues[0];
        throw validationError(
          firstIssue?.message ?? 'Validation failed',
          firstIssue?.path.join('.') ?? undefined,
        );
      }

      const { uploadId } = parseResult.data;
      const userId = request.user!.id;

      const { tempFilePath, originalFilename } = await uploadService.assembleFile(uploadId, userId);
      const { sessionId } = await ingestionService.handleScan(
        { tempFilePath, originalFilename },
        userId,
        request.libraryId!,
      );

      return reply.status(202).send({ data: { sessionId }, meta: null, errors: null });
    },
  );

  // POST /upload — accept a zip file, enqueue ingestion
  // requireLibrary is mandatory: libraryId comes ONLY from request.libraryId,
  // never from query or body parameters.
  app.post(
    '/upload',
    { preHandler: [requireAuth, requireLibrary] },
    async (request, reply) => {
      const data = await request.file();

      if (!data) {
        throw validationError('No file provided');
      }

      const originalFilename = data.filename;
      if (!detectArchiveExtension(originalFilename)) {
        throw validationError('Only .zip, .rar, .7z, and .tar.gz archives are supported');
      }

      // Save upload to a temp file so the ingestion worker can access it later
      const tempDir = os.tmpdir();
      const tempFilePath = path.join(tempDir, `upload_${crypto.randomUUID()}_${originalFilename}`);
      const writeStream = fs.createWriteStream(tempFilePath);
      await pipeline(data.file, writeStream);

      if (data.file.truncated) {
        fs.unlinkSync(tempFilePath);
        throw validationError('File exceeds the maximum allowed size (100MB)');
      }

      const userId = request.user!.id;
      const { sessionId } = await ingestionService.handleScan(
        { tempFilePath, originalFilename },
        userId,
        request.libraryId!,
      );

      return reply.status(202).send({ data: { sessionId }, meta: null, errors: null });
    },
  );

  // --- Staged import sessions (scan → review → commit) ---

  // GET /import-sessions — list the current user's active sessions (the queue)
  app.get(
    '/import-sessions',
    { preHandler: [requireAuth, requireLibrary] },
    async (request, reply) => {
      const sessions = await importSessionService.listActive(request.user!.id, request.libraryId!);
      return reply.status(200).send({ data: sessions, meta: null, errors: null });
    },
  );

  // GET /import-sessions/:id — poll a single session (status + detected metadata)
  app.get(
    '/import-sessions/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const parseResult = importSessionIdParamsSchema.safeParse(request.params);
      if (!parseResult.success) {
        throw validationError(parseResult.error.issues[0]?.message ?? 'Validation failed');
      }
      const row = await importSessionService.getOwnedRow(parseResult.data.id, request.user!.id);
      return reply.status(200).send({ data: importSessionService.toDto(row), meta: null, errors: null });
    },
  );

  // POST /import-sessions/:id/commit — apply batch metadata and create the model
  app.post(
    '/import-sessions/:id/commit',
    { preHandler: [requireAuth, requireLibrary] },
    async (request, reply) => {
      const paramsResult = importSessionIdParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        throw validationError(paramsResult.error.issues[0]?.message ?? 'Validation failed');
      }
      const bodyResult = commitImportSessionSchema.safeParse(request.body ?? {});
      if (!bodyResult.success) {
        const firstIssue = bodyResult.error.issues[0];
        throw validationError(firstIssue?.message ?? 'Validation failed', firstIssue?.path.join('.'));
      }

      const batchMetadata = bodyResult.data.batchMetadata as BatchUploadMetadata | undefined;
      const { modelId, jobId } = await ingestionService.handleCommit(
        paramsResult.data.id,
        batchMetadata,
        request.user!.id,
        request.libraryId!,
      );

      return reply.status(202).send({ data: { modelId, jobId }, meta: null, errors: null });
    },
  );

  // DELETE /import-sessions/:id — discard a session and its staged files
  app.delete(
    '/import-sessions/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const parseResult = importSessionIdParamsSchema.safeParse(request.params);
      if (!parseResult.success) {
        throw validationError(parseResult.error.issues[0]?.message ?? 'Validation failed');
      }
      await ingestionService.discardSession(parseResult.data.id, request.user!.id);
      return reply.status(200).send({ data: null, meta: null, errors: null });
    },
  );

  // POST /import — start folder import
  // requireLibrary is mandatory: libraryId comes ONLY from request.libraryId,
  // never from query or body parameters.
  app.post(
    '/import',
    { preHandler: [requireAuth, requireLibrary, validate(importConfigSchema)] },
    async (request, reply) => {
      const body = request.body as ImportConfig;
      const userId = request.user!.id;

      const { jobId } = await ingestionService.handleFolderImport(body, userId, request.libraryId!);

      return reply.status(202).send({ data: { jobId }, meta: null, errors: null });
    },
  );

  // GET /:id/status — poll processing status
  app.get(
    '/:id/status',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const model = await modelService.getModelById(id);

      // If the model is still processing, also check the job queue for progress
      let progress: number | null = null;
      let error: string | null = null;

      if (model.status === 'processing') {
        // Try to find the most recent job by querying queue
        // We don't store jobId on the model in this schema, so we return model status only
        progress = null;
      } else if (model.status === 'error') {
        error = 'Processing failed';
      }

      return reply.status(200).send({
        data: {
          modelId: model.id,
          status: model.status,
          progress,
          error,
        },
        meta: null,
        errors: null,
      });
    },
  );

  // GET /:id — model detail
  app.get(
    '/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const detail = await presenterService.buildModelDetail(id);

      return reply.status(200).send({ data: detail, meta: null, errors: null });
    },
  );

  // GET /:id/files — file tree for a model
  app.get(
    '/:id/files',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await modelService.getModelById(id); // verify exists
      const files = await modelService.getModelFiles(id);
      const tree = presenterService.buildFileTree(files);

      return reply.status(200).send({ data: tree, meta: null, errors: null });
    },
  );

  // PATCH /:id — update model name/description
  app.patch(
    '/:id',
    { preHandler: [requireAuth, validate(updateModelSchema)] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as UpdateModelRequest;
      await modelService.updateModel(id, body);
      const detail = await presenterService.buildModelDetail(id);

      return reply.status(200).send({ data: detail, meta: null, errors: null });
    },
  );

  // DELETE /:id — delete model and its files from storage
  app.delete(
    '/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      // Get model files to clean up storage
      const files = await modelService.getModelFiles(id);
      await modelService.deleteModel(id);

      // Clean up storage (best-effort, model is already deleted from DB)
      for (const file of files) {
        try {
          await storageService.delete(file.storagePath);
        } catch {
          // Storage cleanup failures are logged but don't fail the request
        }
      }

      return reply.status(200).send({ data: null, meta: null, errors: null });
    },
  );
}
