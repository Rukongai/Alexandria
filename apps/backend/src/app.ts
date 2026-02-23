import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { config } from './config/index.js';
import { errorHandler } from './middleware/error-handler.js';
import { AuthService } from './services/auth.service.js';
import { authRoutes } from './routes/auth.js';
import { modelRoutes } from './routes/models.js';
import { metadataFieldRoutes, modelMetadataRoute } from './routes/metadata.js';
import { bulkRoutes } from './routes/bulk.js';
import { collectionRoutes } from './routes/collections.js';
import { fileRoutes } from './routes/files.js';
import { startIngestionWorker } from './workers/ingestion.worker.js';

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

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 100 * 1024 * 1024, // 100MB
      files: 1,
    },
  });

  // Register raw binary content type for chunked upload routes
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
    done(null, payload);
  });

  // Instantiate services and make them available on the app instance
  const authService = new AuthService();
  (app as typeof app & { authService: AuthService }).authService = authService;

  // Global error handler
  app.setErrorHandler(errorHandler);

  // Health check
  app.get('/health', async (_request, reply) => {
    return reply.status(200).send({ data: { status: 'ok' }, meta: null, errors: null });
  });

  // Route registrations
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(modelRoutes, { prefix: '/models' });
  await app.register(metadataFieldRoutes, { prefix: '/metadata/fields' });
  await app.register(modelMetadataRoute, { prefix: '/models' });
  await app.register(bulkRoutes, { prefix: '/bulk' });
  await app.register(collectionRoutes, { prefix: '/collections' });
  await app.register(fileRoutes, { prefix: '/files' });

  // Start background workers
  startIngestionWorker();

  return app;
}
