import { pipeline } from 'node:stream/promises';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ImportConfig, ModelSearchParams } from '@alexandria/shared';
import { importConfigSchema, modelSearchParamsSchema } from '@alexandria/shared';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { ingestionService } from '../services/ingestion.service.js';
import { modelService } from '../services/model.service.js';
import { searchService } from '../services/search.service.js';
import { validationError } from '../utils/errors.js';

export async function modelRoutes(app: FastifyInstance): Promise<void> {
  // GET / — browse/search models with filters, sorting, pagination
  app.get(
    '/',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const rawQuery = request.query as Record<string, unknown>;

      // Extract metadata.* keys into a metadataFilters record
      const metadataFilters: Record<string, string> = {};
      for (const [key, val] of Object.entries(rawQuery)) {
        if (key.startsWith('metadata.') && typeof val === 'string') {
          const fieldSlug = key.slice('metadata.'.length);
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
      const result = await searchService.searchModels(params);

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

  // POST /upload — accept a zip file, enqueue ingestion
  app.post(
    '/upload',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const data = await request.file();

      if (!data) {
        throw validationError('No file provided');
      }

      const originalFilename = data.filename;
      if (!originalFilename.toLowerCase().endsWith('.zip')) {
        throw validationError('Only .zip files are supported');
      }

      // Save upload to a temp file so the ingestion worker can access it later
      const tempDir = os.tmpdir();
      const tempFilePath = path.join(tempDir, `upload_${crypto.randomUUID()}_${originalFilename}`);
      const writeStream = fs.createWriteStream(tempFilePath);
      await pipeline(data.file, writeStream);

      const userId = request.user!.id;
      const { modelId, jobId } = await ingestionService.handleUpload(
        { tempFilePath, originalFilename },
        userId,
      );

      return reply.status(202).send({ data: { modelId, jobId }, meta: null, errors: null });
    },
  );

  // POST /import — start folder import
  app.post(
    '/import',
    { preHandler: [requireAuth, validate(importConfigSchema)] },
    async (request, reply) => {
      const body = request.body as ImportConfig;
      const userId = request.user!.id;

      const { jobId } = await ingestionService.handleFolderImport(body, userId);

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
      const model = await modelService.getModelById(id);

      return reply.status(200).send({ data: model, meta: null, errors: null });
    },
  );
}
