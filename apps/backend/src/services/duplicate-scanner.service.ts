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

export interface DuplicateScan {
  scannedModelCount: number;
  groups: DuplicateScanGroup[];
}

export interface IDuplicateScannerService {
  scanDuplicates(libraryId: string): Promise<DuplicateScan>;
}

/**
 * Finds exact model duplicates from their complete multisets of per-file
 * SHA-256 hashes. File names and paths deliberately do not participate.
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
    // Aggregate in PostgreSQL so one row crosses the database boundary per
    // eligible model rather than one repeated model row per stored file.
    const rows = await this.database
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

    const groupsByHashMultiset = new Map<string, DuplicateScanGroup>();

    for (const row of rows) {
      // JSON supplies unambiguous element boundaries. Repeated hashes remain
      // repeated, so multiplicity is part of the exact content identity.
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

    const result: DuplicateScan = { scannedModelCount: rows.length, groups };

    logger.debug(
      {
        service: 'DuplicateScannerService',
        libraryId,
        scannedModelCount: result.scannedModelCount,
        duplicateGroupCount: result.groups.length,
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

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export const duplicateScannerService = new DuplicateScannerService();
