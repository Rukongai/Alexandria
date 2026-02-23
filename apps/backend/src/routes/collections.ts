import type { FastifyInstance } from 'fastify';
import type {
  CreateCollectionRequest,
  UpdateCollectionRequest,
  AddModelsToCollectionRequest,
  ModelSearchParams,
} from '@alexandria/shared';
import {
  createCollectionSchema,
  updateCollectionSchema,
  addModelsToCollectionSchema,
  collectionListParamsSchema,
} from '@alexandria/shared';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { collectionService } from '../services/collection.service.js';
import { presenterService } from '../services/presenter.service.js';
import { searchService } from '../services/search.service.js';
import { validationError } from '../utils/errors.js';

export async function collectionRoutes(app: FastifyInstance): Promise<void> {
  // GET / — list top-level collections with optional depth expansion
  app.get(
    '/',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const rawQuery = request.query as Record<string, unknown>;
      const parseResult = collectionListParamsSchema.safeParse(rawQuery);

      if (!parseResult.success) {
        const firstIssue = parseResult.error.issues[0];
        throw validationError(
          firstIssue?.message ?? 'Validation failed',
          firstIssue?.path.join('.') ?? undefined,
        );
      }

      const params = parseResult.data;
      const userId = request.user!.id;
      const collections = await collectionService.listCollections(userId, params);

      return reply.status(200).send({
        data: collections,
        meta: { total: collections.length, cursor: null, pageSize: collections.length },
        errors: null,
      });
    },
  );

  // POST / — create a collection
  app.post(
    '/',
    { preHandler: [requireAuth, validate(createCollectionSchema)] },
    async (request, reply) => {
      const body = request.body as CreateCollectionRequest;
      const userId = request.user!.id;
      const collection = await collectionService.createCollection(body, userId);

      return reply.status(201).send({ data: collection, meta: null, errors: null });
    },
  );

  // GET /:id — single collection detail
  app.get(
    '/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const detail = await presenterService.buildCollectionDetail(id);

      return reply.status(200).send({ data: detail, meta: null, errors: null });
    },
  );

  // PATCH /:id — update a collection
  app.patch(
    '/:id',
    { preHandler: [requireAuth, validate(updateCollectionSchema)] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as UpdateCollectionRequest;
      const updated = await collectionService.updateCollection(id, body);

      return reply.status(200).send({ data: updated, meta: null, errors: null });
    },
  );

  // DELETE /:id — delete a collection (not its models)
  app.delete(
    '/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await collectionService.deleteCollection(id);

      return reply.status(200).send({ data: null, meta: null, errors: null });
    },
  );

  // GET /:id/models — models in a collection (delegates to SearchService)
  app.get(
    '/:id/models',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const rawQuery = request.query as Record<string, unknown>;

      // Verify collection exists
      await collectionService.getCollectionById(id);

      const params: ModelSearchParams = {
        collectionId: id,
        ...(typeof rawQuery.q === 'string' ? { q: rawQuery.q } : {}),
        ...(typeof rawQuery.sort === 'string' ? { sort: rawQuery.sort as ModelSearchParams['sort'] } : {}),
        ...(typeof rawQuery.sortDir === 'string' ? { sortDir: rawQuery.sortDir as ModelSearchParams['sortDir'] } : {}),
        ...(typeof rawQuery.cursor === 'string' ? { cursor: rawQuery.cursor } : {}),
        ...(typeof rawQuery.pageSize === 'string' ? { pageSize: Number(rawQuery.pageSize) } : {}),
      };

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

  // POST /:id/models — add models to a collection
  app.post(
    '/:id/models',
    { preHandler: [requireAuth, validate(addModelsToCollectionSchema)] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as AddModelsToCollectionRequest;
      await collectionService.addModelsToCollection(id, body.modelIds);

      return reply.status(200).send({ data: null, meta: null, errors: null });
    },
  );

  // DELETE /:id/models/:modelId — remove a model from a collection
  app.delete(
    '/:id/models/:modelId',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id, modelId } = request.params as { id: string; modelId: string };
      await collectionService.removeModelFromCollection(id, modelId);

      return reply.status(200).send({ data: null, meta: null, errors: null });
    },
  );
}
