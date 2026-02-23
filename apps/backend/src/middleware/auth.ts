import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UserProfile } from '@alexandria/shared';
import { unauthorized } from '../utils/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: UserProfile | null;
  }
}

const COOKIE_NAME = 'alexandria_session';

export async function requireAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  // @fastify/cookie populates request.cookies; signed cookies are under unsignCookie
  const rawCookie = request.cookies[COOKIE_NAME];

  if (!rawCookie) {
    throw unauthorized('Authentication required');
  }

  const unsigned = request.unsignCookie(rawCookie);
  if (!unsigned.valid || !unsigned.value) {
    throw unauthorized('Authentication required');
  }

  // Resolve the circular dependency at call time — authService is set on the app instance
  const authService = (request.server as import('fastify').FastifyInstance & {
    authService: import('../services/auth.service.js').AuthService;
  }).authService;

  const user = await authService.validateSession(unsigned.value);
  request.user = user;
}
