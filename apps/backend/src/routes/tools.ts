import type { FastifyInstance } from 'fastify';
import {
  duplicateFileGroupParamsSchema,
  type DuplicateFileGroupParams,
} from '@alexandria/shared';
import { requireAuth } from '../middleware/auth.js';
import { requireLibrary } from '../middleware/library.js';
import { duplicateScannerService } from '../services/duplicate-scanner.service.js';
import { presenterService } from '../services/presenter.service.js';
import { validationError } from '../utils/errors.js';

function parseDuplicateFileGroupParams(value: unknown): DuplicateFileGroupParams {
  const parsed = duplicateFileGroupParamsSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw validationError(issue?.message ?? 'Invalid route parameters', issue?.path.join('.'));
  }
  return parsed.data;
}

export async function toolsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/duplicates',
    { preHandler: [requireAuth, requireLibrary] },
    async (request, reply) => {
      const scan = await duplicateScannerService.scanDuplicates(request.libraryId!);
      const result = presenterService.buildDuplicateScanResult(scan);
      return reply.status(200).send({ data: result, meta: null, errors: null });
    },
  );

  app.post(
    '/duplicates/mark',
    { preHandler: [requireAuth, requireLibrary] },
    async (request, reply) => {
      const result = await duplicateScannerService.markDuplicates(request.libraryId!);
      return reply.status(200).send({ data: result, meta: null, errors: null });
    },
  );

  app.post(
    '/duplicates/file-groups/:hash/mark',
    { preHandler: [requireAuth, requireLibrary] },
    async (request, reply) => {
      const { hash } = parseDuplicateFileGroupParams(request.params);
      const result = await duplicateScannerService.markDuplicateFileGroup(
        request.libraryId!,
        hash,
      );
      return reply.status(200).send({ data: result, meta: null, errors: null });
    },
  );

  app.post(
    '/duplicates/file-groups/:hash/ignore',
    { preHandler: [requireAuth, requireLibrary] },
    async (request, reply) => {
      const { hash } = parseDuplicateFileGroupParams(request.params);
      const result = await duplicateScannerService.ignoreDuplicateFileGroup(
        request.libraryId!,
        hash,
      );
      return reply.status(200).send({ data: result, meta: null, errors: null });
    },
  );
}
