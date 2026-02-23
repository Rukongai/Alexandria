import type { FastifyInstance } from 'fastify';
import { bulkMetadataSchema } from '@alexandria/shared';
import type { BulkMetadataRequest } from '@alexandria/shared';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { metadataService } from '../services/metadata.service.js';

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
}
