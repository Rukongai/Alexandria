import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { IgnoreDuplicatesResult, MarkDuplicatesResult } from '@alexandria/shared';
import { db } from '../db/index.js';
import type { DatabaseExecutor } from '../db/index.js';
import {
  duplicateFileIgnores,
  duplicateModelIgnores,
  modelFiles,
  models,
} from '../db/schema/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('DuplicateScannerService');

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
  ignoreDuplicates(libraryId: string): Promise<IgnoreDuplicatesResult>;
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
    return this.withTransaction(async (tx) => {
      const scan = await this.runScan(libraryId, tx);
      return this.reconcileFlagsFromScan(libraryId, scan, tx);
    });
  }

  /** Persist every currently reported duplicate key, then clear stale review flags. */
  async ignoreDuplicates(libraryId: string): Promise<IgnoreDuplicatesResult> {
    const result = await this.withTransaction(async (tx) => {
      const scan = await this.runScan(libraryId, tx);

      if (scan.fileGroups.length > 0) {
        await tx
          .insert(duplicateFileIgnores)
          .values(scan.fileGroups.map((group) => ({ libraryId, hash: group.hash })))
          .onConflictDoNothing({
            target: [duplicateFileIgnores.libraryId, duplicateFileIgnores.hash],
          });
      }
      if (scan.groups.length > 0) {
        await tx
          .insert(duplicateModelIgnores)
          .values(scan.groups.map((group) => ({ libraryId, fingerprint: group.fingerprint })))
          .onConflictDoNothing({
            target: [duplicateModelIgnores.libraryId, duplicateModelIgnores.fingerprint],
          });
      }

      const remaining = await this.runScan(libraryId, tx);
      await this.reconcileFlagsFromScan(libraryId, remaining, tx);

      return {
        ignoredFileGroupCount: scan.fileGroups.length,
        ignoredModelGroupCount: scan.groups.length,
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
    const scan = await this.runScan(libraryId, executor);
    return this.reconcileFlagsFromScan(libraryId, scan, executor);
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

  private async reconcileFlagsFromScan(
    libraryId: string,
    scan: DuplicateScan,
    executor: DatabaseExecutor,
  ): Promise<MarkDuplicatesResult> {
    const candidateFileIds = [...new Set(
      scan.fileGroups.flatMap((group) => group.files.map((file) => file.id)),
    )];
    const fileCandidateCondition = candidateFileIds.length > 0
      ? inArray(modelFiles.id, candidateFileIds)
      : sql<boolean>`false`;

    await executor
      .update(modelFiles)
      .set({ isDuplicate: fileCandidateCondition })
      .where(sql<boolean>`${modelFiles.modelId} in (
        select ${models.id} from ${models} where ${models.libraryId} = ${libraryId}
      )`);

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
      markedFileCount: candidateFileIds.length,
      markedModelCount: reconciledModels.filter((model) => model.isDuplicate).length,
    };
  }

  private async withTransaction<T>(
    callback: (executor: DatabaseExecutor) => Promise<T>,
  ): Promise<T> {
    const database = this.database as DatabaseExecutor & {
      transaction?: (callback: (executor: DatabaseExecutor) => Promise<T>) => Promise<T>;
    };
    if (typeof database.transaction === 'function') {
      return database.transaction(callback);
    }
    return callback(database);
  }
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
