import type { FastifyInstance } from 'fastify';
import { bulkMetadataSchema, bulkCollectionSchema, bulkDeleteSchema } from '@alexandria/shared';
import type { BulkMetadataRequest, BulkCollectionRequest, BulkDeleteRequest } from '@alexandria/shared';
import { requireAuth } from '../middleware/auth.js';
import { requireLibrary } from '../middleware/library.js';
import { validate } from '../middleware/validate.js';
import { bulkService } from '../services/bulk.service.js';

export async function bulkRoutes(app: FastifyInstance): Promise<void> {
  // POST /metadata — apply bulk metadata operations across multiple models
  app.post(
    '/metadata',
    { preHandler: [requireAuth, requireLibrary, validate(bulkMetadataSchema)] },
    async (request, reply) => {
      const body = request.body as BulkMetadataRequest;
      await bulkService.setMetadata(body, request.user!.id, request.libraryId!);
      return reply.status(200).send({ data: null, meta: null, errors: null });
    },
  );

  // POST /collection — bulk add/remove models from a collection
  app.post(
    '/collection',
    { preHandler: [requireAuth, requireLibrary, validate(bulkCollectionSchema)] },
    async (request, reply) => {
      const body = request.body as BulkCollectionRequest;
      await bulkService.updateCollection(body, request.user!.id, request.libraryId!);
      return reply.status(200).send({ data: null, meta: null, errors: null });
    },
  );

  // POST /delete — bulk delete models with storage cleanup
  app.post(
    '/delete',
    { preHandler: [requireAuth, requireLibrary, validate(bulkDeleteSchema)] },
    async (request, reply) => {
      const body = request.body as BulkDeleteRequest;
      const result = await bulkService.deleteModels(body, request.user!.id, request.libraryId!);
      return reply.status(200).send({
        data: result,
        meta: null,
        errors: null,
      });
    },
  );
}
