import { createHash } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { IgnoreDuplicatesResult, MarkDuplicatesResult } from '@alexandria/shared';
import { db } from '../db/index.js';
import type { DatabaseExecutor } from '../db/index.js';
import {
  duplicateFileIgnores,
  duplicateModelIgnores,
  modelFiles,
  models,
} from '../db/schema/index.js';
import { notFound } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('DuplicateScannerService');
const MAX_SERIALIZABLE_ATTEMPTS = 3;
const RETRYABLE_TRANSACTION_CODES = new Set(['40001', '40P01']);

export interface DuplicateScanCandidate {
  id: string;
  name: string;
  originalFilename: string | null;
  createdAt: Date;
  totalSizeBytes: number;
}

export interface DuplicateScanGroup {
  fingerprint: string;
  fileCount: number;
  models: DuplicateScanCandidate[];
}

export interface DuplicateFileScanCandidate {
  id: string;
  modelId: string;
  modelName: string;
  filename: string;
  relativePath: string;
  sizeBytes: number;
  createdAt: Date;
  modelCreatedAt: Date;
}

export interface DuplicateFileScanGroup {
  hash: string;
  files: DuplicateFileScanCandidate[];
}

export interface DuplicateScan {
  scannedModelCount: number;
  scannedFileCount: number;
  groups: DuplicateScanGroup[];
  fileGroups: DuplicateFileScanGroup[];
}

export interface IDuplicateScannerService {
  scanDuplicates(libraryId: string): Promise<DuplicateScan>;
  markDuplicates(libraryId: string): Promise<MarkDuplicatesResult>;
  markDuplicateFileGroup(libraryId: string, hash: string): Promise<MarkDuplicatesResult>;
  ignoreDuplicateFileGroup(libraryId: string, hash: string): Promise<IgnoreDuplicatesResult>;
  reconcileDuplicateFlags(
    libraryId: string,
    executor?: DatabaseExecutor,
  ): Promise<MarkDuplicatesResult>;
}

/**
 * Finds duplicate files by SHA-256 and exact model duplicates from their
 * complete multisets of per-file SHA-256 hashes. Names and paths deliberately
 * do not participate in either identity.
 */
export class DuplicateScannerService implements IDuplicateScannerService {
  private readonly inFlightByLibrary = new Map<string, Promise<DuplicateScan>>();

  constructor(private readonly database: DatabaseExecutor = db) {}

  /** Coalesce concurrent requests for the same library onto one database scan. */
  scanDuplicates(libraryId: string): Promise<DuplicateScan> {
    const existing = this.inFlightByLibrary.get(libraryId);
    if (existing) return existing;

    const scan = this.runScan(libraryId);
    this.inFlightByLibrary.set(libraryId, scan);
    void scan
      .finally(() => {
        if (this.inFlightByLibrary.get(libraryId) === scan) {
          this.inFlightByLibrary.delete(libraryId);
        }
      })
      .catch(() => undefined);

    return scan;
  }

  /** Mark exactly the current, non-ignored duplicate candidates in one transaction. */
  async markDuplicates(libraryId: string): Promise<MarkDuplicatesResult> {
    return this.withSerializableTransaction(
      (tx) => this.reconcileFlags(libraryId, tx, { markAll: true }),
    );
  }

  /** Mark one current, non-ignored file group while preserving other current marks. */
  async markDuplicateFileGroup(libraryId: string, hash: string): Promise<MarkDuplicatesResult> {
    return this.withSerializableTransaction(async (tx) => {
      const scan = await this.runScan(libraryId, tx);
      const group = scan.fileGroups.find((candidate) => candidate.hash === hash);
      if (!group) throw notFound('Duplicate file group not found');

      return this.reconcileFlags(libraryId, tx, { markHash: group.hash });
    });
  }

  /** Persist one current file-group key, then clear its review flags. */
  async ignoreDuplicateFileGroup(libraryId: string, hash: string): Promise<IgnoreDuplicatesResult> {
    const result = await this.withSerializableTransaction(async (tx) => {
      const scan = await this.runScan(libraryId, tx);
      const group = scan.fileGroups.find((candidate) => candidate.hash === hash);
      if (!group) throw notFound('Duplicate file group not found');

      await tx
        .insert(duplicateFileIgnores)
        .values({ libraryId, hash: group.hash })
        .onConflictDoNothing({
          target: [duplicateFileIgnores.libraryId, duplicateFileIgnores.hash],
        });

      await this.reconcileFlags(libraryId, tx);

      return {
        ignoredFileGroupCount: 1,
        ignoredModelGroupCount: 0,
      };
    });

    this.inFlightByLibrary.delete(libraryId);
    return result;
  }

  /**
   * Recompute review flags after any mutation that can change duplicate
   * membership. Callers may supply their transaction so flags commit with the
   * structural change.
   */
  async reconcileDuplicateFlags(
    libraryId: string,
    executor: DatabaseExecutor = this.database,
  ): Promise<MarkDuplicatesResult> {
    return this.reconcileFlags(libraryId, executor);
  }

  private async runScan(
    libraryId: string,
    executor: DatabaseExecutor = this.database,
  ): Promise<DuplicateScan> {
    // Keep the complete hash multiset aggregation in PostgreSQL so unique-file
    // detail does not cross the database boundary. The second query returns
    // candidate detail only for hashes that occur more than once in this same
    // ready-model/library scope.
    const modelRowsQuery = executor
      .select({
        id: models.id,
        name: models.name,
        originalFilename: models.originalFilename,
        totalSizeBytes: models.totalSizeBytes,
        createdAt: models.createdAt,
        hashes: sql<string[]>`array_agg(${modelFiles.hash} order by ${modelFiles.hash}, ${modelFiles.id})`,
      })
      .from(models)
      .innerJoin(modelFiles, eq(modelFiles.modelId, models.id))
      .where(and(eq(models.libraryId, libraryId), eq(models.status, 'ready')))
      .groupBy(models.id)
      .orderBy(asc(models.createdAt), asc(models.id));

    const duplicateFileRowsQuery = executor
      .select({
        modelId: models.id,
        modelName: models.name,
        modelCreatedAt: models.createdAt,
        fileId: modelFiles.id,
        filename: modelFiles.filename,
        relativePath: modelFiles.relativePath,
        fileSizeBytes: modelFiles.sizeBytes,
        fileCreatedAt: modelFiles.createdAt,
        hash: modelFiles.hash,
      })
      .from(models)
      .innerJoin(modelFiles, eq(modelFiles.modelId, models.id))
      .where(and(
        eq(models.libraryId, libraryId),
        eq(models.status, 'ready'),
        sql<boolean>`not exists (
          select 1 from ${duplicateFileIgnores}
          where ${duplicateFileIgnores.libraryId} = ${libraryId}
            and ${duplicateFileIgnores.hash} = ${modelFiles.hash}
        )`,
        sql<boolean>`${modelFiles.hash} in (
          select duplicate_file.hash
          from model_files as duplicate_file
          inner join models as duplicate_model on duplicate_model.id = duplicate_file.model_id
          where duplicate_model.library_id = ${libraryId}
            and duplicate_model.status = 'ready'
          group by duplicate_file.hash
          having count(*) > 1
        )`,
      ))
      .orderBy(
        asc(modelFiles.createdAt),
        asc(modelFiles.id),
        asc(modelFiles.hash),
      );

    const ignoredModelRowsQuery = executor
      .select({ fingerprint: duplicateModelIgnores.fingerprint })
      .from(duplicateModelIgnores)
      .where(eq(duplicateModelIgnores.libraryId, libraryId));

    const [modelRows, duplicateFileRows, ignoredModelRows] = await Promise.all([
      modelRowsQuery,
      duplicateFileRowsQuery,
      ignoredModelRowsQuery,
    ]);
    const ignoredModelFingerprints = new Set(ignoredModelRows.map((row) => row.fingerprint));

    const filesByHash = new Map<string, DuplicateFileScanCandidate[]>();

    for (const row of duplicateFileRows) {
      const file: DuplicateFileScanCandidate = {
        id: row.fileId,
        modelId: row.modelId,
        modelName: row.modelName,
        filename: row.filename,
        relativePath: row.relativePath,
        sizeBytes: row.fileSizeBytes,
        createdAt: row.fileCreatedAt,
        modelCreatedAt: row.modelCreatedAt,
      };
      const matchingFiles = filesByHash.get(row.hash);
      if (matchingFiles) matchingFiles.push(file);
      else filesByHash.set(row.hash, [file]);
    }

    const groupsByHashMultiset = new Map<string, DuplicateScanGroup>();
    for (const row of modelRows) {
      // JSON supplies unambiguous element boundaries. Repeated hashes remain
      // repeated, so multiplicity is part of the exact model identity.
      const hashMultisetKey = JSON.stringify(row.hashes);
      const existing = groupsByHashMultiset.get(hashMultisetKey);
      const candidate: DuplicateScanCandidate = {
        id: row.id,
        name: row.name,
        originalFilename: row.originalFilename,
        createdAt: row.createdAt,
        totalSizeBytes: row.totalSizeBytes,
      };

      if (existing) {
        existing.models.push(candidate);
      } else {
        groupsByHashMultiset.set(hashMultisetKey, {
          fingerprint: createHash('sha256').update(hashMultisetKey).digest('hex'),
          fileCount: row.hashes.length,
          models: [candidate],
        });
      }
    }

    const groups = [...groupsByHashMultiset.values()]
      .filter((group) =>
        group.models.length > 1 && !ignoredModelFingerprints.has(group.fingerprint))
      .map((group) => ({ ...group, models: [...group.models].sort(compareCandidates) }))
      .sort(compareGroups);
    const fileGroups = [...filesByHash.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([hash, files]) => ({ hash, files: [...files].sort(compareFileCandidates) }))
      .sort(compareFileGroups);

    const result: DuplicateScan = {
      scannedModelCount: modelRows.length,
      scannedFileCount: modelRows.reduce((sum, row) => sum + row.hashes.length, 0),
      groups,
      fileGroups,
    };

    logger.debug(
      {
        service: 'DuplicateScannerService',
        libraryId,
        scannedModelCount: result.scannedModelCount,
        scannedFileCount: result.scannedFileCount,
        duplicateModelGroupCount: result.groups.length,
        duplicateFileGroupCount: result.fileGroups.length,
      },
      'Completed duplicate scan',
    );

    return result;
  }

  private async reconcileFlags(
    libraryId: string,
    executor: DatabaseExecutor,
    options: { markAll?: boolean; markHash?: string } = {},
  ): Promise<MarkDuplicatesResult> {
    // Re-evaluate membership in the UPDATE statement instead of trusting the
    // preceding scan. Under PostgreSQL READ COMMITTED, an ignore or deletion
    // committed before this statement begins is therefore visible here.
    const fileCandidateCondition = sql<boolean>`exists (
        select 1 from ${models} as duplicate_owner
        where duplicate_owner.id = ${modelFiles.modelId}
          and duplicate_owner.library_id = ${libraryId}
          and duplicate_owner.status = 'ready'
      )
      and not exists (
        select 1 from ${duplicateFileIgnores}
        where ${duplicateFileIgnores.libraryId} = ${libraryId}
          and ${duplicateFileIgnores.hash} = ${modelFiles.hash}
      )
      and ${modelFiles.hash} in (
        select duplicate_file.hash
        from ${modelFiles} as duplicate_file
        inner join ${models} as duplicate_model
          on duplicate_model.id = duplicate_file.model_id
        where duplicate_model.library_id = ${libraryId}
          and duplicate_model.status = 'ready'
        group by duplicate_file.hash
        having count(*) > 1
      )`;
    const requestedFileCondition = options.markHash
      ? eq(modelFiles.hash, options.markHash)
      : sql<boolean>`false`;
    const reconciledFileFlag = options.markAll
      ? fileCandidateCondition
      : sql<boolean>`${fileCandidateCondition}
          and (${modelFiles.isDuplicate} or ${requestedFileCondition})`;

    const reconciledFiles = await executor
      .update(modelFiles)
      .set({ isDuplicate: reconciledFileFlag })
      .where(sql<boolean>`${modelFiles.modelId} in (
        select ${models.id} from ${models} where ${models.libraryId} = ${libraryId}
      )`)
      .returning({ isDuplicate: modelFiles.isDuplicate });

    const reconciledModels = await executor
      .update(models)
      .set({
        isDuplicate: sql<boolean>`${models.status} = 'ready'
          and exists (
            select 1 from ${modelFiles}
            where ${modelFiles.modelId} = ${models.id}
          )
          and not exists (
            select 1 from ${modelFiles}
            where ${modelFiles.modelId} = ${models.id}
              and ${modelFiles.isDuplicate} = false
          )`,
      })
      .where(eq(models.libraryId, libraryId))
      .returning({ isDuplicate: models.isDuplicate });

    return {
      markedFileCount: reconciledFiles.filter((file) => file.isDuplicate).length,
      markedModelCount: reconciledModels.filter((model) => model.isDuplicate).length,
    };
  }

  private async withSerializableTransaction<T>(
    callback: (executor: DatabaseExecutor) => Promise<T>,
  ): Promise<T> {
    const database = this.database as DatabaseExecutor & {
      transaction?: (
        callback: (executor: DatabaseExecutor) => Promise<T>,
        config?: { isolationLevel: 'serializable' },
      ) => Promise<T>;
    };
    if (typeof database.transaction !== 'function') return callback(database);

    for (let attempt = 1; attempt <= MAX_SERIALIZABLE_ATTEMPTS; attempt += 1) {
      try {
        return await database.transaction(callback, { isolationLevel: 'serializable' });
      } catch (error) {
        if (attempt === MAX_SERIALIZABLE_ATTEMPTS || !isRetryableTransactionError(error)) {
          throw error;
        }
      }
    }

    throw new Error('Serializable transaction retry loop exhausted');
  }
}

function isRetryableTransactionError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return RETRYABLE_TRANSACTION_CODES.has(String(error.code));
}

function compareCandidates(left: DuplicateScanCandidate, right: DuplicateScanCandidate): number {
  return left.createdAt.getTime() - right.createdAt.getTime() || compareStrings(left.id, right.id);
}

function compareGroups(left: DuplicateScanGroup, right: DuplicateScanGroup): number {
  const leftOldest = left.models[0];
  const rightOldest = right.models[0];
  return leftOldest.createdAt.getTime() - rightOldest.createdAt.getTime()
    || compareStrings(leftOldest.id, rightOldest.id)
    || compareStrings(left.fingerprint, right.fingerprint);
}

function compareFileCandidates(
  left: DuplicateFileScanCandidate,
  right: DuplicateFileScanCandidate,
): number {
  return left.createdAt.getTime() - right.createdAt.getTime()
    || compareStrings(left.id, right.id)
    || left.modelCreatedAt.getTime() - right.modelCreatedAt.getTime()
    || compareStrings(left.modelId, right.modelId);
}

function compareFileGroups(left: DuplicateFileScanGroup, right: DuplicateFileScanGroup): number {
  return left.files[0].createdAt.getTime() - right.files[0].createdAt.getTime()
    || compareStrings(left.hash, right.hash)
    || compareStrings(left.files[0].id, right.files[0].id);
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export const duplicateScannerService = new DuplicateScannerService();
