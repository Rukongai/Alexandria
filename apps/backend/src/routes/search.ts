import type { FastifyInstance } from 'fastify';
import type { GlobalSearchParams } from '@alexandria/shared';
import { globalSearchParamsSchema } from '@alexandria/shared';
import { requireAuth } from '../middleware/auth.js';
import { requireLibrary } from '../middleware/library.js';
import { searchService } from '../services/search.service.js';
import { validationError } from '../utils/errors.js';

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  // GET /search — cross-entity search (models, collections, artists, tags)
  app.get(
    '/',
    { preHandler: [requireAuth, requireLibrary] },
    async (request, reply) => {
      const parseResult = globalSearchParamsSchema.safeParse(request.query);
      if (!parseResult.success) {
        const firstIssue = parseResult.error.issues[0];
        throw validationError(firstIssue?.message ?? 'Validation failed', firstIssue?.path.join('.'));
      }

      const params = parseResult.data as GlobalSearchParams;
      const result = await searchService.searchAll(params, request.user!.id, request.libraryId!);

      return reply.status(200).send({ data: result, meta: null, errors: null });
    },
  );
}
