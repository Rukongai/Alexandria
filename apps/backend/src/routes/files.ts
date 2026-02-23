import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { modelFiles, thumbnails } from '../db/schema/index.js';
import { storageService } from '../services/storage.service.js';
import { notFound } from '../utils/errors.js';
import { requireAuth } from '../middleware/auth.js';

const CACHE_MAX_AGE = 60 * 60 * 24; // 1 day in seconds

const MIME_TYPES: Record<string, string> = {
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.stl': 'model/stl',
  '.obj': 'model/obj',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
};

function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  // GET /thumbnails/:id.webp — serve a thumbnail by ID
  app.get(
    '/thumbnails/:filename',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { filename } = request.params as { filename: string };
      const thumbnailId = filename.replace(/\.webp$/, '');

      const [thumb] = await db
        .select({ storagePath: thumbnails.storagePath })
        .from(thumbnails)
        .where(eq(thumbnails.id, thumbnailId))
        .limit(1);

      if (!thumb) {
        throw notFound(`Thumbnail not found: ${thumbnailId}`);
      }

      const stream = storageService.retrieveStream(thumb.storagePath);

      return reply
        .header('Content-Type', 'image/webp')
        .header('Cache-Control', `public, max-age=${CACHE_MAX_AGE}`)
        .send(stream);
    },
  );

  // GET /models/:modelId/* — serve a model file by modelId and relative path
  app.get(
    '/models/:modelId/*',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { modelId } = request.params as { modelId: string };
      const relativePath = (request.params as Record<string, string>)['*'];

      if (!relativePath) {
        throw notFound('File path is required');
      }

      const [file] = await db
        .select({
          storagePath: modelFiles.storagePath,
          filename: modelFiles.filename,
          mimeType: modelFiles.mimeType,
        })
        .from(modelFiles)
        .where(
          and(
            eq(modelFiles.modelId, modelId),
            eq(modelFiles.relativePath, relativePath),
          ),
        )
        .limit(1);

      if (!file) {
        throw notFound(`File not found: ${relativePath}`);
      }

      const stream = storageService.retrieveStream(file.storagePath);
      const contentType = file.mimeType || getMimeType(file.filename);

      return reply
        .header('Content-Type', contentType)
        .header('Cache-Control', `public, max-age=${CACHE_MAX_AGE}`)
        .send(stream);
    },
  );
}
