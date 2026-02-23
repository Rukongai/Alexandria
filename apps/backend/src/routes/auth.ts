import type { FastifyInstance } from 'fastify';
import { loginSchema, updateProfileSchema } from '@alexandria/shared';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import type { AuthService } from '../services/auth.service.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const authService: AuthService = (app as FastifyInstance & { authService: AuthService })
    .authService;

  // POST /login
  app.post(
    '/login',
    { preHandler: [validate(loginSchema)] },
    async (request, reply) => {
      const { email, password } = request.body as { email: string; password: string };
      const { user } = await authService.authenticate(email, password);
      authService.setCookie(reply, user.id);
      return reply.status(200).send({ data: user, meta: null, errors: null });
    },
  );

  // POST /logout
  app.post('/logout', async (_request, reply) => {
    authService.clearCookie(reply);
    return reply.status(200).send({ data: null, meta: null, errors: null });
  });

  // GET /me
  app.get(
    '/me',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      return reply.status(200).send({ data: request.user, meta: null, errors: null });
    },
  );

  // PATCH /me
  app.patch(
    '/me',
    { preHandler: [requireAuth, validate(updateProfileSchema)] },
    async (request, reply) => {
      const updates = request.body as {
        displayName?: string;
        email?: string;
        currentPassword?: string;
        newPassword?: string;
      };
      const updated = await authService.updateProfile(request.user!.id, updates);
      return reply.status(200).send({ data: updated, meta: null, errors: null });
    },
  );
}
