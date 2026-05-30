import type { FastifyReply, FastifyRequest } from 'fastify';
import { libraryService } from '../services/library.service.js';
import { unauthorized } from '../utils/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    libraryId: string | null;
  }
}

export async function requireLibrary(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (!request.user) {
    throw unauthorized('Authentication required');
  }

  request.libraryId = await libraryService.resolveDefaultLibraryId(request.user.id);
}
