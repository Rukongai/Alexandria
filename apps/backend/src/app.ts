import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyCookie from '@fastify/cookie';
import { config } from './config/index.js';
import { errorHandler } from './middleware/error-handler.js';
import { AuthService } from './services/auth.service.js';
import { authRoutes } from './routes/auth.js';

export async function buildApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({
    logger: {
      level: config.nodeEnv === 'production' ? 'info' : 'debug',
    },
  });

  // Decorate request with user (null until requireAuth sets it)
  app.decorateRequest('user', null);

  // Register plugins
  await app.register(fastifyCors, {
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    credentials: true,
  });

  await app.register(fastifyCookie, {
    secret: config.sessionSecret,
  });

  // Instantiate services and make them available on the app instance
  const authService = new AuthService(app);
  (app as typeof app & { authService: AuthService }).authService = authService;

  // Global error handler
  app.setErrorHandler(errorHandler);

  // Health check
  app.get('/health', async (_request, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });

  // Route registrations
  await app.register(authRoutes, { prefix: '/auth' });

  return app;
}
