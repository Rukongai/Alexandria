import type { FastifyInstance } from 'fastify';
import type { CreateLibraryRequest, UpdateLibraryRequest } from '@alexandria/shared';
import { createLibrarySchema, updateLibrarySchema } from '@alexandria/shared';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { libraryService } from '../services/library.service.js';

/**
 * Library management routes. These manage the library scope itself, so they use
 * only requireAuth (NOT requireLibrary) and resolve ownership inside the service
 * via the userId. libraryId is taken from the URL :id and always ownership-checked.
 */
export async function libraryRoutes(app: FastifyInstance): Promise<void> {
  // GET / — list the user's libraries with model/collection counts (home cards)
  app.get('/', { preHandler: [requireAuth] }, async (request, reply) => {
    const items = await libraryService.listLibraries(request.user!.id);
    return reply.status(200).send({
      data: items,
      meta: { total: items.length, cursor: null, pageSize: items.length },
      errors: null,
    });
  });

  // POST / — create a new library
  app.post(
    '/',
    { preHandler: [requireAuth, validate(createLibrarySchema)] },
    async (request, reply) => {
      const body = request.body as CreateLibraryRequest;
      const library = await libraryService.createLibrary(request.user!.id, body);
      return reply.status(201).send({ data: library, meta: null, errors: null });
    },
  );

  // PATCH /:id — rename / recolor a library
  app.patch(
    '/:id',
    { preHandler: [requireAuth, validate(updateLibrarySchema)] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as UpdateLibraryRequest;
      const library = await libraryService.updateLibrary(request.user!.id, id, body);
      return reply.status(200).send({ data: library, meta: null, errors: null });
    },
  );

  // POST /:id/set-default — mark this library as the user's default
  app.post('/:id/set-default', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await libraryService.setDefaultLibrary(request.user!.id, id);
    return reply.status(200).send({ data: null, meta: null, errors: null });
  });

  // DELETE /:id — delete an empty, non-default library
  app.delete('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await libraryService.deleteLibrary(request.user!.id, id);
    return reply.status(200).send({ data: null, meta: null, errors: null });
  });
}
