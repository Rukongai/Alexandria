import type { FastifyInstance } from 'fastify';
import { bulkMetadataSchema, bulkCollectionSchema, bulkDeleteSchema } from '@alexandria/shared';
import type { BulkMetadataRequest, BulkCollectionRequest, BulkDeleteRequest } from '@alexandria/shared';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { metadataService } from '../services/metadata.service.js';
import { collectionService } from '../services/collection.service.js';
import { modelService } from '../services/model.service.js';
import { storageService } from '../services/storage.service.js';

export async function bulkRoutes(app: FastifyInstance): Promise<void> {
  // POST /metadata — apply bulk metadata operations across multiple models
  app.post(
    '/metadata',
    { preHandler: [requireAuth, validate(bulkMetadataSchema)] },
    async (request, reply) => {
      const body = request.body as BulkMetadataRequest;
      await metadataService.bulkSetMetadata(body.modelIds, body.operations);
      return reply.status(200).send({ data: null, meta: null, errors: null });
    },
  );

  // POST /collection — bulk add/remove models from a collection
  app.post(
    '/collection',
    { preHandler: [requireAuth, validate(bulkCollectionSchema)] },
    async (request, reply) => {
      const body = request.body as BulkCollectionRequest;
      await collectionService.bulkCollectionOperation(body);
      return reply.status(200).send({ data: null, meta: null, errors: null });
    },
  );

  // POST /delete — bulk delete models with storage cleanup
  app.post(
    '/delete',
    { preHandler: [requireAuth, validate(bulkDeleteSchema)] },
    async (request, reply) => {
      const body = request.body as BulkDeleteRequest;

      // Collect storage paths before deleting from DB
      const storageCleanup: string[] = [];
      for (const modelId of body.modelIds) {
        const files = await modelService.getModelFiles(modelId);
        storageCleanup.push(...files.map((f) => f.storagePath));
      }

      const deleted = await modelService.deleteModels(body.modelIds);

      // Best-effort storage cleanup
      for (const storagePath of storageCleanup) {
        try {
          await storageService.delete(storagePath);
        } catch {
          // Log but don't fail
        }
      }

      return reply.status(200).send({
        data: { deletedCount: deleted.length, deletedIds: deleted },
        meta: null,
        errors: null,
      });
    },
  );
}
