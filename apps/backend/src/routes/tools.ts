import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { requireLibrary } from '../middleware/library.js';
import { duplicateScannerService } from '../services/duplicate-scanner.service.js';
import { presenterService } from '../services/presenter.service.js';

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
    '/duplicates/ignore',
    { preHandler: [requireAuth, requireLibrary] },
    async (request, reply) => {
      const result = await duplicateScannerService.ignoreDuplicates(request.libraryId!);
      return reply.status(200).send({ data: result, meta: null, errors: null });
    },
  );
}
