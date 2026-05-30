import type { FastifyReply, FastifyRequest } from 'fastify';
import { libraryService } from '../services/library.service.js';
import { unauthorized } from '../utils/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    libraryId: string | null;
  }
}

/** Header the frontend mirrors its `/lib/:id` route segment into. */
const LIBRARY_HEADER = 'x-library-id';

/**
 * Resolve the active library scope onto request.libraryId.
 *
 * The library is taken from the `X-Library-Id` header (the frontend sets it from
 * the `/lib/:id` route). When present it MUST belong to the authenticated user —
 * an unknown or un-owned id resolves to NOT_FOUND, never another user's data.
 * When the header is absent we fall back to the user's default library, which
 * preserves the single-library behavior every existing route relied on before P5.
 */
export async function requireLibrary(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (!request.user) {
    throw unauthorized('Authentication required');
  }

  const header = request.headers?.[LIBRARY_HEADER];
  const requestedId = Array.isArray(header) ? header[0] : header;

  request.libraryId = await libraryService.resolveLibraryId(request.user.id, requestedId ?? null);
}
