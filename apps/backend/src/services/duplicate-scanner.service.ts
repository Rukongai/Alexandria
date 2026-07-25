import { createHash } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import type { DatabaseExecutor } from '../db/index.js';
import { modelFiles, models } from '../db/schema/index.js';
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

  private async runScan(libraryId: string): Promise<DuplicateScan> {
    // Keep the complete hash multiset aggregation in PostgreSQL so unique-file
    // detail does not cross the database boundary. The second query returns
    // candidate detail only for hashes that occur more than once in this same
    // ready-model/library scope.
    const modelRowsQuery = this.database
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

    const duplicateFileRowsQuery = this.database
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

    const [modelRows, duplicateFileRows] = await Promise.all([
      modelRowsQuery,
      duplicateFileRowsQuery,
    ]);

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
      .filter((group) => group.models.length > 1)
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
