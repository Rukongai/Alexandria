import type { FastifyInstance } from 'fastify';
import {
  createMetadataFieldSchema,
  updateMetadataFieldSchema,
  setModelMetadataSchema,
} from '@alexandria/shared';
import type {
  CreateMetadataFieldRequest,
  UpdateMetadataFieldRequest,
  SetModelMetadataRequest,
} from '@alexandria/shared';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { metadataService } from '../services/metadata.service.js';

export async function metadataFieldRoutes(app: FastifyInstance): Promise<void> {
  // GET / — list all metadata field definitions
  app.get(
    '/',
    { preHandler: [requireAuth] },
    async (_request, reply) => {
      const fields = await metadataService.listFields();
      return reply.status(200).send({ data: fields, meta: null, errors: null });
    },
  );

  // POST / — create a new metadata field definition
  app.post(
    '/',
    { preHandler: [requireAuth, validate(createMetadataFieldSchema)] },
    async (request, reply) => {
      const body = request.body as CreateMetadataFieldRequest;
      const field = await metadataService.createField(body);
      return reply.status(201).send({ data: field, meta: null, errors: null });
    },
  );

  // PATCH /:id — update a metadata field definition
  app.patch(
    '/:id',
    { preHandler: [requireAuth, validate(updateMetadataFieldSchema)] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as UpdateMetadataFieldRequest;
      const field = await metadataService.updateField(id, body);
      return reply.status(200).send({ data: field, meta: null, errors: null });
    },
  );

  // DELETE /:id — delete a metadata field definition
  app.delete(
    '/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await metadataService.deleteField(id);
      return reply.status(200).send({ data: null, meta: null, errors: null });
    },
  );

  // GET /:slug/values — list known values for a field
  app.get(
    '/:slug/values',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const values = await metadataService.listFieldValues(slug);
      return reply.status(200).send({ data: values, meta: null, errors: null });
    },
  );
}

export async function modelMetadataRoute(app: FastifyInstance): Promise<void> {
  // PATCH /:id/metadata — set metadata on a specific model
  app.patch(
    '/:id/metadata',
    { preHandler: [requireAuth, validate(setModelMetadataSchema)] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as SetModelMetadataRequest;
      await metadataService.setModelMetadata(id, body);
      return reply.status(200).send({ data: null, meta: null, errors: null });
    },
  );
}
