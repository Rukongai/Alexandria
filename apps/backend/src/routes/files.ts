import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { modelFiles, thumbnails } from '../db/schema/index.js';
import { storageService } from '../services/storage.service.js';
import { notFound } from '../utils/errors.js';
import { requireAuth } from '../middleware/auth.js';

const MODEL_CACHE_MAX_AGE = 60 * 60 * 24; // 1 day in seconds
const THUMBNAIL_CACHE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year in seconds

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

function contentDispositionFilename(filename: string): string {
  return filename.replace(/["\r\n]/g, '_');
}

function thumbnailEtag(thumbnailId: string): string {
  return `"${thumbnailId}"`;
}

function modelFileEtag(hash: string): string {
  return `"${hash}"`;
}

function ifNoneMatchMatches(
  header: string | string[] | undefined,
  currentEtag: string,
): boolean {
  if (!header) return false;
  const value = Array.isArray(header) ? header.join(',') : header;

  for (const candidate of splitEntityTags(value)) {
    const trimmed = candidate.trim();
    if (trimmed === '*') return true;
    const withoutWeakPrefix = trimmed.startsWith('W/"') ? trimmed.slice(2) : trimmed;
    if (withoutWeakPrefix === currentEtag) return true;
  }
  return false;
}

function splitEntityTags(value: string): string[] {
  const tags: string[] = [];
  let start = 0;
  let quoted = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') quoted = !quoted;
    if (character === ',' && !quoted) {
      tags.push(value.slice(start, index));
      start = index + 1;
    }
  }
  tags.push(value.slice(start));
  return tags;
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

      const etag = thumbnailEtag(thumbnailId);
      const response = reply
        .header('Cache-Control', `private, max-age=${THUMBNAIL_CACHE_MAX_AGE}, immutable`)
        .header('Vary', 'Cookie')
        .header('ETag', etag);

      if (ifNoneMatchMatches(request.headers['if-none-match'], etag)) {
        return response.code(304).send();
      }

      const stream = await storageService.retrieveStream(thumb.storagePath);

      return response
        .header('Content-Type', 'image/webp')
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
      const { download } = request.query as { download?: string };

      if (!relativePath) {
        throw notFound('File path is required');
      }

      const [file] = await db
        .select({
          storagePath: modelFiles.storagePath,
          filename: modelFiles.filename,
          mimeType: modelFiles.mimeType,
          hash: modelFiles.hash,
          sizeBytes: modelFiles.sizeBytes,
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

      const etag = modelFileEtag(file.hash);
      const response = reply
        .header('Cache-Control', `private, max-age=${MODEL_CACHE_MAX_AGE}`)
        .header('Vary', 'Cookie')
        .header('ETag', etag);

      if (ifNoneMatchMatches(request.headers['if-none-match'], etag)) {
        return response.code(304).send();
      }

      const stream = await storageService.retrieveStream(file.storagePath);
      const contentType = file.mimeType || getMimeType(file.filename);

      response
        .header('Content-Type', contentType)
        .header('Content-Length', file.sizeBytes);

      if (download === '1' || download === 'true') {
        response.header(
          'Content-Disposition',
          `attachment; filename="${contentDispositionFilename(file.filename)}"`,
        );
      }

      return response.send(stream);
    },
  );
}
