import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  ImportSession,
  ImportSessionStatus,
  DetectedImportMetadata,
} from '@alexandria/shared';
import type { FileManifest } from './file-processing.service.js';
import { db } from '../db/index.js';
import { importSessions } from '../db/schema/index.js';
import { notFound } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ImportSessionService');

/** How long an un-committed session is kept before it is eligible for cleanup. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Statuses that still represent live, user-actionable sessions (the queue). */
const ACTIVE_STATUSES: ImportSessionStatus[] = [
  'scanning',
  'ready_for_review',
  'committing',
  'error',
];

type ImportSessionRow = typeof importSessions.$inferSelect;

export class ImportSessionService {
  async create(input: {
    userId: string;
    libraryId: string;
    originalFilename: string;
  }): Promise<{ id: string }> {
    const [row] = await db
      .insert(importSessions)
      .values({
        userId: input.userId,
        libraryId: input.libraryId,
        originalFilename: input.originalFilename,
        status: 'scanning',
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      })
      .returning({ id: importSessions.id });
    return row;
  }

  async getRow(id: string): Promise<ImportSessionRow | undefined> {
    const [row] = await db.select().from(importSessions).where(eq(importSessions.id, id)).limit(1);
    return row;
  }

  /** Fetch a row, asserting it exists and belongs to the user. */
  async getOwnedRow(id: string, userId: string): Promise<ImportSessionRow> {
    const row = await this.getRow(id);
    if (!row || row.userId !== userId) {
      throw notFound('Import session not found');
    }
    return row;
  }

  async listActive(userId: string, libraryId: string): Promise<ImportSession[]> {
    const rows = await db
      .select()
      .from(importSessions)
      .where(
        and(
          eq(importSessions.userId, userId),
          eq(importSessions.libraryId, libraryId),
          inArray(importSessions.status, ACTIVE_STATUSES),
        ),
      )
      .orderBy(desc(importSessions.createdAt));
    return rows.map((r) => this.toDto(r));
  }

  async update(
    id: string,
    fields: Partial<{
      status: ImportSessionStatus;
      detected: DetectedImportMetadata | null;
      manifest: FileManifest | null;
      stagingPath: string | null;
      modelId: string | null;
      error: string | null;
    }>,
  ): Promise<void> {
    await db
      .update(importSessions)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(importSessions.id, id));
  }

  async delete(id: string): Promise<void> {
    await db.delete(importSessions).where(eq(importSessions.id, id));
    logger.info({ sessionId: id }, 'Import session deleted');
  }

  toDto(row: ImportSessionRow): ImportSession {
    return {
      id: row.id,
      originalFilename: row.originalFilename,
      status: row.status as ImportSessionStatus,
      detected: (row.detected as DetectedImportMetadata | null) ?? null,
      modelId: row.modelId,
      error: row.error,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

export const importSessionService = new ImportSessionService();
