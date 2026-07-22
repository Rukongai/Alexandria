import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  AiChatRequest,
  CreateAiProviderRequest,
  UpdateAiProviderRequest,
} from '@alexandria/shared';
import {
  aiChatSchema,
  aiProposalIdParamsSchema,
  aiProviderIdParamsSchema,
  createAiProviderSchema,
  updateAiProviderSchema,
} from '@alexandria/shared';
import type { ZodSchema } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireLibrary } from '../middleware/library.js';
import { validate } from '../middleware/validate.js';
import { aiAssistantService } from '../services/ai-assistant.service.js';
import { aiProposalService } from '../services/ai-proposal.service.js';
import { aiProviderService } from '../services/ai-provider.service.js';
import { validationError } from '../utils/errors.js';

function parseParams<T>(schema: ZodSchema<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw validationError(issue?.message ?? 'Invalid route parameters', issue?.path.join('.'));
  }
  return parsed.data;
}

export function monitorClientDisconnect(
  request: FastifyRequest,
  reply: FastifyReply,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('AI chat client disconnected'));
    }
  };
  const abortOnPrematureResponseClose = () => {
    if (!reply.raw.writableEnded) abort();
  };

  request.raw.once('aborted', abort);
  reply.raw.once('close', abortOnPrematureResponseClose);
  if (request.raw.aborted || (reply.raw.destroyed && !reply.raw.writableEnded)) abort();

  let cleanedUp = false;
  return {
    signal: controller.signal,
    cleanup: () => {
      if (cleanedUp) return;
      cleanedUp = true;
      request.raw.removeListener('aborted', abort);
      reply.raw.removeListener('close', abortOnPrematureResponseClose);
    },
  };
}

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/providers', { preHandler: [requireAuth] }, async (request, reply) => {
    const providers = await aiProviderService.list(request.user!.id);
    return reply.status(200).send({
      data: providers,
      meta: { total: providers.length, cursor: null, pageSize: providers.length },
      errors: null,
    });
  });

  app.post(
    '/providers',
    { preHandler: [requireAuth, validate(createAiProviderSchema)] },
    async (request, reply) => {
      const provider = await aiProviderService.create(
        request.user!.id,
        request.body as CreateAiProviderRequest,
      );
      return reply.status(201).send({ data: provider, meta: null, errors: null });
    },
  );

  app.patch(
    '/providers/:id',
    { preHandler: [requireAuth, validate(updateAiProviderSchema)] },
    async (request, reply) => {
      const { id } = parseParams(aiProviderIdParamsSchema, request.params);
      const provider = await aiProviderService.update(
        request.user!.id,
        id,
        request.body as UpdateAiProviderRequest,
      );
      return reply.status(200).send({ data: provider, meta: null, errors: null });
    },
  );

  app.delete('/providers/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = parseParams(aiProviderIdParamsSchema, request.params);
    await aiProviderService.delete(request.user!.id, id);
    return reply.status(200).send({ data: null, meta: null, errors: null });
  });

  app.post('/providers/:id/test', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = parseParams(aiProviderIdParamsSchema, request.params);
    const result = await aiProviderService.test(request.user!.id, id);
    return reply.status(200).send({ data: result, meta: null, errors: null });
  });

  app.get('/providers/:id/models', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = parseParams(aiProviderIdParamsSchema, request.params);
    const models = await aiProviderService.listModels(request.user!.id, id);
    return reply.status(200).send({
      data: models,
      meta: { total: models.length, cursor: null, pageSize: models.length },
      errors: null,
    });
  });

  app.post(
    '/chat',
    { preHandler: [requireAuth, requireLibrary, validate(aiChatSchema)] },
    async (request, reply) => {
      const disconnect = monitorClientDisconnect(request, reply);
      try {
        const result = await aiAssistantService.chat(
          request.body as AiChatRequest,
          request.user!.id,
          request.libraryId!,
          disconnect.signal,
        );
        return reply.status(200).send({ data: result, meta: null, errors: null });
      } finally {
        disconnect.cleanup();
      }
    },
  );

  app.post(
    '/proposals/:id/apply',
    { preHandler: [requireAuth, requireLibrary] },
    async (request, reply) => {
      const { id } = parseParams(aiProposalIdParamsSchema, request.params);
      const result = await aiProposalService.apply(id, request.user!.id, request.libraryId!);
      return reply.status(200).send({ data: result, meta: null, errors: null });
    },
  );
}
