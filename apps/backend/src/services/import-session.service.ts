import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type {
  BatchUploadMetadata,
  ImportSession,
  ImportCommitProgress,
  ImportSessionStatus,
  DetectedImportMetadata,
} from '@alexandria/shared';
import type { FileManifest } from './file-processing.service.js';
import { db } from '../db/index.js';
import type { DatabaseExecutor } from '../db/index.js';
import { importSessions } from '../db/schema/index.js';
import { notFound } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { jobService } from './job.service.js';

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

interface CommitProgressSource {
  getImportCommitProgress(sessionId: string): Promise<ImportCommitProgress | null>;
}

export class ImportSessionService {
  constructor(private readonly commitProgressSource: CommitProgressSource = jobService) {}

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

  async getOwnedSession(id: string, userId: string): Promise<ImportSession> {
    const row = await this.getOwnedRow(id, userId);
    return this.toDto(row, await this.resolveCommitProgress(row));
  }

  /** Fetch an active session only when it belongs to the user and active library. */
  async getOwnedActiveSession(
    id: string,
    userId: string,
    libraryId: string,
  ): Promise<ImportSession> {
    const [row] = await db
      .select()
      .from(importSessions)
      .where(and(
        eq(importSessions.id, id),
        eq(importSessions.userId, userId),
        eq(importSessions.libraryId, libraryId),
        inArray(importSessions.status, ACTIVE_STATUSES),
      ))
      .limit(1);
    if (!row) throw notFound('Import session not found');
    return this.toDto(row, await this.resolveCommitProgress(row));
  }

  /** Resolve one staged session suitable for a draft proposal. */
  async getOwnedReadyForReviewRow(
    id: string,
    userId: string,
    libraryId: string,
    executor: DatabaseExecutor = db,
  ): Promise<ImportSessionRow> {
    const [row] = await executor
      .select()
      .from(importSessions)
      .where(and(
        eq(importSessions.id, id),
        eq(importSessions.userId, userId),
        eq(importSessions.libraryId, libraryId),
        eq(importSessions.status, 'ready_for_review'),
      ))
      .limit(1);
    if (!row) throw notFound('Import session not found');
    return row;
  }

  /**
   * Deterministically lock all referenced staged sessions before proposal apply.
   * A mismatch is reported as NOT_FOUND without revealing which scope failed.
   */
  async lockOwnedReadyForReviewSessions(
    ids: string[],
    userId: string,
    libraryId: string,
    executor: DatabaseExecutor,
  ): Promise<ImportSessionRow[]> {
    const uniqueIds = [...new Set(ids)].sort();
    if (uniqueIds.length === 0) return [];
    const rows = await executor
      .select()
      .from(importSessions)
      .where(and(
        inArray(importSessions.id, uniqueIds),
        eq(importSessions.userId, userId),
        eq(importSessions.libraryId, libraryId),
        eq(importSessions.status, 'ready_for_review'),
      ))
      .orderBy(asc(importSessions.id))
      .for('update');
    if (rows.length !== uniqueIds.length) throw notFound('Import session not found');
    return rows;
  }

  /**
   * Deterministically lock sessions in the caller's user/library scope without
   * filtering by status. Commit uses this variant so it can distinguish an
   * owned session in the wrong state from an out-of-scope session while still
   * making the state check under the row lock.
   */
  async lockOwnedSessions(
    ids: string[],
    userId: string,
    libraryId: string,
    executor: DatabaseExecutor,
  ): Promise<ImportSessionRow[]> {
    const uniqueIds = [...new Set(ids)].sort();
    if (uniqueIds.length === 0) return [];
    const rows = await executor
      .select()
      .from(importSessions)
      .where(and(
        inArray(importSessions.id, uniqueIds),
        eq(importSessions.userId, userId),
        eq(importSessions.libraryId, libraryId),
      ))
      .orderBy(asc(importSessions.id))
      .for('update');
    if (rows.length !== uniqueIds.length) throw notFound('Import session not found');
    return rows;
  }

  async listActive(
    userId: string,
    libraryId: string,
    params: { limit?: number } = {},
  ): Promise<ImportSession[]> {
    const query = db
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
    const rows = params.limit === undefined ? await query : await query.limit(params.limit);
    return Promise.all(
      rows.map(async (row) => this.toDto(row, await this.resolveCommitProgress(row))),
    );
  }

  async update(
    id: string,
    fields: Partial<{
      status: ImportSessionStatus;
      detected: DetectedImportMetadata | null;
      manifest: FileManifest | null;
      stagingPath: string | null;
      modelId: string | null;
      draftMetadata: BatchUploadMetadata | null;
      error: string | null;
    }>,
    executor: DatabaseExecutor = db,
  ): Promise<void> {
    await executor
      .update(importSessions)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(importSessions.id, id));
  }

  /** Merge an assistant/user draft patch using the caller's transaction. */
  async updateDraftMetadata(
    id: string,
    patch: BatchUploadMetadata,
    executor: DatabaseExecutor = db,
  ): Promise<BatchUploadMetadata> {
    const [row] = await executor
      .select({ draftMetadata: importSessions.draftMetadata })
      .from(importSessions)
      .where(eq(importSessions.id, id))
      .limit(1);
    if (!row) throw notFound('Import session not found');

    const existing = (row.draftMetadata as BatchUploadMetadata | null) ?? {};
    const next: BatchUploadMetadata = { ...existing, ...patch };
    if (patch.metadata !== undefined) {
      next.metadata = { ...(existing.metadata ?? {}), ...patch.metadata };
    }
    if (patch.options !== undefined) {
      next.options = { ...(existing.options ?? {}), ...patch.options };
    }
    // An explicit collection choice replaces the other choice semantically.
    if (patch.collectionId !== undefined) delete next.newCollectionName;
    if (patch.newCollectionName !== undefined) delete next.collectionId;

    await executor
      .update(importSessions)
      .set({ draftMetadata: next, updatedAt: new Date() })
      .where(eq(importSessions.id, id));
    return next;
  }

  async delete(id: string): Promise<void> {
    await db.delete(importSessions).where(eq(importSessions.id, id));
    logger.info({ sessionId: id }, 'Import session deleted');
  }

  toDto(
    row: ImportSessionRow,
    commitProgress: ImportCommitProgress | null = null,
  ): ImportSession {
    return {
      id: row.id,
      originalFilename: row.originalFilename,
      status: row.status as ImportSessionStatus,
      detected: (row.detected as DetectedImportMetadata | null) ?? null,
      draftMetadata: (row.draftMetadata as BatchUploadMetadata | null) ?? null,
      modelId: row.modelId,
      commitProgress: row.status === 'committing' ? commitProgress : null,
      error: row.error,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async resolveCommitProgress(
    row: ImportSessionRow,
  ): Promise<ImportCommitProgress | null> {
    if (row.status !== 'committing') return null;

    try {
      const progress = await this.commitProgressSource.getImportCommitProgress(row.id);
      if (progress) return progress;
    } catch (error) {
      logger.warn(
        { sessionId: row.id, error: String(error) },
        'Failed to read import commit progress',
      );
    }

    const detected = (row.detected as DetectedImportMetadata | null) ?? null;
    return {
      phase: 'queued',
      percent: 0,
      completedFiles: 0,
      totalFiles: detected?.fileCount ?? 0,
      completedBytes: 0,
      totalBytes: detected?.totalSizeBytes ?? 0,
      currentFilename: null,
    };
  }
}

export const importSessionService = new ImportSessionService();
