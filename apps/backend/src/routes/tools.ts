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
}
