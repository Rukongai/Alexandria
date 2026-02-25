import type { FastifyInstance } from 'fastify';
import type { CreateLibraryInput, UpdateLibraryInput } from '@alexandria/shared';
import { createLibrarySchema, updateLibrarySchema } from '@alexandria/shared';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { libraryService } from '../services/library.service.js';

export async function libraryRoutes(app: FastifyInstance): Promise<void> {
  // GET / — list all libraries
  app.get(
    '/',
    { preHandler: [requireAuth] },
    async (_request, reply) => {
      const libraries = await libraryService.listLibraries();

      return reply.status(200).send({ data: libraries, meta: null, errors: null });
    },
  );

  // POST / — create a library
  app.post(
    '/',
    { preHandler: [requireAuth, validate(createLibrarySchema)] },
    async (request, reply) => {
      const body = request.body as CreateLibraryInput;
      const library = await libraryService.createLibrary(body);

      return reply.status(201).send({ data: library, meta: null, errors: null });
    },
  );

  // GET /:id — get library by id
  app.get(
    '/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const library = await libraryService.getLibraryById(id);

      return reply.status(200).send({ data: library, meta: null, errors: null });
    },
  );

  // PATCH /:id — update a library
  app.patch(
    '/:id',
    { preHandler: [requireAuth, validate(updateLibrarySchema)] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as UpdateLibraryInput;
      const library = await libraryService.updateLibrary(id, body);

      return reply.status(200).send({ data: library, meta: null, errors: null });
    },
  );

  // DELETE /:id — delete a library
  app.delete(
    '/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await libraryService.deleteLibrary(id);

      return reply.status(200).send({ data: null, meta: null, errors: null });
    },
  );

  // GET /:id/models — list models in a library
  app.get(
    '/:id/models',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      // Verify library exists before fetching models
      await libraryService.getLibraryById(id);
      const models = await libraryService.getModelsByLibraryId(id);

      return reply.status(200).send({ data: models, meta: null, errors: null });
    },
  );
}
