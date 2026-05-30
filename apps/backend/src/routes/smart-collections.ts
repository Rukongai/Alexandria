import type { FastifyInstance } from 'fastify';
import type {
  CreateSmartCollectionRequest,
  UpdateSmartCollectionRequest,
  PreviewSmartCollectionRequest,
  ModelSearchParams,
} from '@alexandria/shared';
import {
  createSmartCollectionSchema,
  updateSmartCollectionSchema,
  previewSmartCollectionSchema,
  modelSearchParamsSchema,
} from '@alexandria/shared';
import { requireAuth } from '../middleware/auth.js';
import { requireLibrary } from '../middleware/library.js';
import { validate } from '../middleware/validate.js';
import { smartCollectionService } from '../services/smart-collection.service.js';
import type { SearchResult } from '../services/search.service.js';
import { validationError } from '../utils/errors.js';

/** Parse model-search query params (including metadata.* keys) from a raw query. */
function parseModelParams(rawQuery: Record<string, unknown>): ModelSearchParams {
  const metadataFilters: Record<string, string> = {};
  for (const [key, val] of Object.entries(rawQuery)) {
    if (key.startsWith('metadata.') && typeof val === 'string') {
      const fieldSlug = key.slice('metadata.'.length);
      if (fieldSlug) metadataFilters[fieldSlug] = val;
    }
  }

  const parsed = modelSearchParamsSchema.safeParse({
    ...rawQuery,
    ...(Object.keys(metadataFilters).length > 0 ? { metadataFilters } : {}),
  });
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    throw validationError(firstIssue?.message ?? 'Validation failed', firstIssue?.path.join('.'));
  }
  return parsed.data as ModelSearchParams;
}

function modelsEnvelope(result: SearchResult) {
  return {
    data: result.models,
    meta: { total: result.total, cursor: result.cursor, pageSize: result.pageSize },
    errors: null,
  };
}

export async function smartCollectionRoutes(app: FastifyInstance): Promise<void> {
  // requireLibrary is mandatory on every route: libraryId comes ONLY from
  // request.libraryId, never from query or body. Every :id route additionally
  // goes through the service's requireOwnedSmartCollection cross-tenant guard.

  // GET / — list smart collections (no derived counts; kept cheap)
  app.get('/', { preHandler: [requireAuth, requireLibrary] }, async (request, reply) => {
    const items = await smartCollectionService.list(request.user!.id, request.libraryId!);
    return reply.status(200).send({
      data: items,
      meta: { total: items.length, cursor: null, pageSize: items.length },
      errors: null,
    });
  });

  // POST / — create a smart collection
  app.post(
    '/',
    { preHandler: [requireAuth, requireLibrary, validate(createSmartCollectionSchema)] },
    async (request, reply) => {
      const body = request.body as CreateSmartCollectionRequest;
      const detail = await smartCollectionService.create(body, request.user!.id, request.libraryId!);
      return reply.status(201).send({ data: detail, meta: null, errors: null });
    },
  );

  // POST /preview — dry-run an unsaved rule tree (static route; declared before /:id)
  app.post(
    '/preview',
    { preHandler: [requireAuth, requireLibrary, validate(previewSmartCollectionSchema)] },
    async (request, reply) => {
      const body = request.body as PreviewSmartCollectionRequest;
      const { definition, ...rest } = body;
      const params = rest as ModelSearchParams;
      const result = await smartCollectionService.preview(definition, params, request.libraryId!);
      return reply.status(200).send(modelsEnvelope(result));
    },
  );

  // GET /:id — single smart collection (with derived model count)
  app.get('/:id', { preHandler: [requireAuth, requireLibrary] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const detail = await smartCollectionService.getById(id, request.user!.id, request.libraryId!);
    return reply.status(200).send({ data: detail, meta: null, errors: null });
  });

  // PATCH /:id — update name/description/definition
  app.patch(
    '/:id',
    { preHandler: [requireAuth, requireLibrary, validate(updateSmartCollectionSchema)] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as UpdateSmartCollectionRequest;
      const detail = await smartCollectionService.update(
        id,
        body,
        request.user!.id,
        request.libraryId!,
      );
      return reply.status(200).send({ data: detail, meta: null, errors: null });
    },
  );

  // DELETE /:id — delete a smart collection
  app.delete('/:id', { preHandler: [requireAuth, requireLibrary] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await smartCollectionService.delete(id, request.user!.id, request.libraryId!);
    return reply.status(200).send({ data: null, meta: null, errors: null });
  });

  // GET /:id/models — the rule-derived result set
  app.get('/:id/models', { preHandler: [requireAuth, requireLibrary] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const params = parseModelParams(request.query as Record<string, unknown>);
    const result = await smartCollectionService.getModels(
      id,
      params,
      request.user!.id,
      request.libraryId!,
    );
    return reply.status(200).send(modelsEnvelope(result));
  });
}
