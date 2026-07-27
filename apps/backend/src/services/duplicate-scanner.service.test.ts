import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { ErrorCodes } from '@alexandria/shared';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { DuplicateScannerService } from './duplicate-scanner.service.js';

interface FileCandidateRow {
  modelId: string;
  modelName: string;
  originalFilename: string | null;
  modelTotalSizeBytes: number;
  modelCreatedAt: Date;
  fileId: string;
  filename: string;
  relativePath: string;
  fileSizeBytes: number;
  fileCreatedAt: Date;
  hash: string;
}

interface ModelCandidateRow {
  id: string;
  name: string;
  originalFilename: string | null;
  totalSizeBytes: number;
  createdAt: Date;
  hashes: string[];
}

interface ArchiveCandidateRow {
  modelId: string;
  modelName: string;
  modelCreatedAt: Date;
  archiveFileId: string;
  archiveFilename: string;
  archiveRelativePath: string;
  archiveStoragePath: string;
  archiveFileCreatedAt: Date;
}

function databaseReturning(
  rows: FileCandidateRow[],
  ignoredFingerprints: string[] = [],
  archiveRows: ArchiveCandidateRow[] = [],
) {
  const modelRows = [...rows.reduce((byModel, row) => {
    const existing = byModel.get(row.modelId);
    if (existing) existing.hashes.push(row.hash);
    else byModel.set(row.modelId, {
      id: row.modelId,
      name: row.modelName,
      originalFilename: row.originalFilename,
      totalSizeBytes: row.modelTotalSizeBytes,
      createdAt: row.modelCreatedAt,
      hashes: [row.hash],
    });
    return byModel;
  }, new Map<string, ModelCandidateRow>()).values()]
    .map((model) => ({ ...model, hashes: model.hashes.sort() }));
  const hashCounts = rows.reduce((counts, row) => {
    counts.set(row.hash, (counts.get(row.hash) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
  const duplicateFileRows = rows.filter((row) => (hashCounts.get(row.hash) ?? 0) > 1);

  const modelQuery = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    groupBy: vi.fn(),
    orderBy: vi.fn(),
  };
  modelQuery.from.mockReturnValue(modelQuery);
  modelQuery.innerJoin.mockReturnValue(modelQuery);
  modelQuery.where.mockReturnValue(modelQuery);
  modelQuery.groupBy.mockReturnValue(modelQuery);
  modelQuery.orderBy.mockResolvedValue(modelRows);

  const fileQuery = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
  };
  fileQuery.from.mockReturnValue(fileQuery);
  fileQuery.innerJoin.mockReturnValue(fileQuery);
  fileQuery.where.mockReturnValue(fileQuery);
  fileQuery.orderBy.mockResolvedValue(duplicateFileRows);

  const ignoredModelQuery = {
    from: vi.fn(),
    where: vi.fn(),
  };
  ignoredModelQuery.from.mockReturnValue(ignoredModelQuery);
  ignoredModelQuery.where.mockResolvedValue(
    ignoredFingerprints.map((fingerprint) => ({ fingerprint })),
  );

  const archiveQuery = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
  };
  archiveQuery.from.mockReturnValue(archiveQuery);
  archiveQuery.innerJoin.mockReturnValue(archiveQuery);
  archiveQuery.where.mockReturnValue(archiveQuery);
  archiveQuery.orderBy.mockResolvedValue(archiveRows);

  const ignoredFileHashQuery = {
    from: vi.fn(),
    where: vi.fn(),
  };
  ignoredFileHashQuery.from.mockReturnValue(ignoredFileHashQuery);
  ignoredFileHashQuery.where.mockResolvedValue([]);

  return {
    database: {
      select: vi.fn()
        .mockReturnValueOnce(modelQuery)
        .mockReturnValueOnce(fileQuery)
        .mockReturnValueOnce(ignoredModelQuery)
        .mockReturnValueOnce(archiveQuery)
        .mockReturnValueOnce(ignoredFileHashQuery),
    },
    modelQuery,
    fileQuery,
    archiveQuery,
  };
}

function withReconciliationUpdates(database: { select: ReturnType<typeof vi.fn> }) {
  let fileFlag: SQL | undefined;
  const fileUpdate = {
    set: vi.fn((values: { isDuplicate: SQL }) => {
      fileFlag = values.isDuplicate;
      return fileUpdate;
    }),
    where: vi.fn(() => fileUpdate),
    returning: vi.fn().mockResolvedValue([]),
  };
  const modelUpdate = {
    set: vi.fn(() => modelUpdate),
    where: vi.fn(() => modelUpdate),
    returning: vi.fn().mockResolvedValue([]),
  };
  const update = vi.fn()
    .mockReturnValueOnce(fileUpdate)
    .mockReturnValueOnce(modelUpdate);
  Object.assign(database, { update });

  return {
    getFileFlag: () => fileFlag,
    update,
  };
}

function fileRow(
  modelId: string,
  hash: string,
  options: {
    fileId?: string;
    modelName?: string;
    originalFilename?: string | null;
    modelTotalSizeBytes?: number;
    modelCreatedAt?: string;
    filename?: string;
    relativePath?: string;
    fileSizeBytes?: number;
    fileCreatedAt?: string;
  } = {},
): FileCandidateRow {
  const fileId = options.fileId ?? `${modelId}-${hash}`;
  return {
    modelId,
    hash,
    modelName: options.modelName ?? modelId,
    originalFilename: options.originalFilename ?? `${modelId}.zip`,
    modelTotalSizeBytes: options.modelTotalSizeBytes ?? 100,
    modelCreatedAt: new Date(options.modelCreatedAt ?? '2026-01-01T00:00:00.000Z'),
    fileId,
    filename: options.filename ?? `${fileId}.stl`,
    relativePath: options.relativePath ?? `parts/${fileId}.stl`,
    fileSizeBytes: options.fileSizeBytes ?? 50,
    fileCreatedAt: new Date(
      options.fileCreatedAt ?? options.modelCreatedAt ?? '2026-01-01T01:00:00.000Z',
    ),
  };
}

function archiveRow(
  modelId: string,
  archiveFileId: string,
  options: Partial<ArchiveCandidateRow> = {},
): ArchiveCandidateRow {
  const modelCreatedAt = options.modelCreatedAt ?? new Date('2026-01-01T00:00:00.000Z');
  return {
    modelId,
    modelName: options.modelName ?? modelId,
    modelCreatedAt,
    archiveFileId,
    archiveFilename: options.archiveFilename ?? `${archiveFileId}.zip`,
    archiveRelativePath: options.archiveRelativePath ?? `archives/${archiveFileId}.zip`,
    archiveStoragePath: options.archiveStoragePath ?? `models/${modelId}/${archiveFileId}.zip`,
    archiveFileCreatedAt: options.archiveFileCreatedAt ?? modelCreatedAt,
  };
}

describe('DuplicateScannerService', () => {
  it('finds individual duplicate files and complete model hash multisets', async () => {
    const { database, modelQuery, fileQuery } = databaseReturning([
      fileRow('new-copy', 'hash-a', {
        fileId: 'new-a',
        modelName: 'Renamed copy',
        originalFilename: 'different-source.7z',
        modelTotalSizeBytes: 120,
        modelCreatedAt: '2026-02-01T00:00:00.000Z',
      }),
      fileRow('new-copy', 'hash-b', {
        fileId: 'new-b',
        modelName: 'Renamed copy',
        originalFilename: 'different-source.7z',
        modelTotalSizeBytes: 120,
        modelCreatedAt: '2026-02-01T00:00:00.000Z',
      }),
      fileRow('old-copy', 'hash-a', { fileId: 'old-a', modelName: 'Original' }),
      fileRow('old-copy', 'hash-b', { fileId: 'old-b', modelName: 'Original' }),
      fileRow('single-a', 'hash-a', { fileId: 'single-a' }),
      fileRow('repeated-a', 'hash-a', { fileId: 'repeated-a-1' }),
      fileRow('repeated-a', 'hash-a', { fileId: 'repeated-a-2' }),
    ]);
    const service = new DuplicateScannerService(database as never);

    const result = await service.scanDuplicates('library-1');

    expect(database.select).toHaveBeenCalledTimes(5);
    expect(modelQuery.groupBy).toHaveBeenCalledOnce();
    expect(fileQuery.where).toHaveBeenCalledOnce();
    expect(result.scannedModelCount).toBe(4);
    expect(result.scannedFileCount).toBe(7);
    expect(result.groups).toEqual([
      {
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        fileCount: 2,
        models: [
          {
            id: 'old-copy',
            name: 'Original',
            originalFilename: 'old-copy.zip',
            totalSizeBytes: 100,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
          },
          {
            id: 'new-copy',
            name: 'Renamed copy',
            originalFilename: 'different-source.7z',
            totalSizeBytes: 120,
            createdAt: new Date('2026-02-01T00:00:00.000Z'),
          },
        ],
      },
    ]);
    expect(result.fileGroups.map((group) => ({
      hash: group.hash,
      ids: group.files.map((file) => file.id),
    }))).toEqual([
      { hash: 'hash-a', ids: ['old-a', 'repeated-a-1', 'repeated-a-2', 'single-a', 'new-a'] },
      { hash: 'hash-b', ids: ['old-b', 'new-b'] },
    ]);
  });

  it('returns stable ordering for models, files, and groups regardless of row order', async () => {
    const rows = [
      fileRow('group-b-new', 'hash-z', { fileId: 'b-new', modelCreatedAt: '2026-04-01T00:00:00.000Z' }),
      fileRow('group-a-new', 'hash-a', { fileId: 'a-new', modelCreatedAt: '2026-03-01T00:00:00.000Z' }),
      fileRow('group-b-old', 'hash-z', { fileId: 'b-old', modelCreatedAt: '2026-02-01T00:00:00.000Z' }),
      fileRow('group-a-old', 'hash-a', { fileId: 'a-old', modelCreatedAt: '2026-01-01T00:00:00.000Z' }),
    ];
    const first = databaseReturning(rows);
    const second = databaseReturning([...rows].reverse());

    const firstResult = await new DuplicateScannerService(first.database as never)
      .scanDuplicates('library-1');
    const secondResult = await new DuplicateScannerService(second.database as never)
      .scanDuplicates('library-1');

    expect(firstResult).toEqual(secondResult);
    expect(firstResult.groups.map((group) => group.models.map((model) => model.id))).toEqual([
      ['group-a-old', 'group-a-new'],
      ['group-b-old', 'group-b-new'],
    ]);
    expect(firstResult.fileGroups.map((group) => group.files.map((file) => file.id))).toEqual([
      ['a-old', 'a-new'],
      ['b-old', 'b-new'],
    ]);
  });

  it('coalesces concurrent scans for the same library', async () => {
    const fixture = databaseReturning([fileRow('only-model', 'hash-a')]);
    const service = new DuplicateScannerService(fixture.database as never);

    const [first, second] = await Promise.all([
      service.scanDuplicates('library-1'),
      service.scanDuplicates('library-1'),
    ]);

    expect(first).toEqual(second);
    expect(fixture.database.select).toHaveBeenCalledTimes(5);
  });

  it('does not scan or group models without files', async () => {
    const { database } = databaseReturning([]);

    await expect(new DuplicateScannerService(database as never).scanDuplicates('library-1'))
      .resolves.toEqual({
        scannedModelCount: 0,
        scannedFileCount: 0,
        scannedArchiveFileCount: 0,
        scannedArchiveEntryCount: 0,
        groups: [],
        fileGroups: [],
        archiveFileGroups: [],
      });
  });

  it('finds duplicate members across stored archives without making them actionable file groups', async () => {
    const fixture = databaseReturning([], [], [
      archiveRow('model-old', 'archive-old', {
        archiveFileCreatedAt: new Date('2026-01-01T01:00:00.000Z'),
      }),
      archiveRow('model-new', 'archive-new', {
        archiveFileCreatedAt: new Date('2026-02-01T01:00:00.000Z'),
      }),
    ]);
    const storage = {
      retrieveStream: vi.fn().mockResolvedValue(Readable.from([Buffer.from('archive')])),
    };
    const fileProcessing = {
      processArchive: vi.fn().mockImplementation(async (archivePath: string) => ({
        entries: [
          {
            filename: 'body.stl',
            relativePath: 'meshes/body.stl',
            sizeBytes: 12,
            hash: 'member-hash',
          },
          ...(archivePath.includes('archive-old') ? [{
            filename: 'unique.stl',
            relativePath: 'unique.stl',
            sizeBytes: 7,
            hash: 'unique-hash',
          }] : []),
        ],
      })),
    };

    const result = await new DuplicateScannerService(
      fixture.database as never,
      storage as never,
      fileProcessing as never,
    ).scanDuplicates('library-1');

    expect(result.scannedArchiveFileCount).toBe(2);
    expect(result.scannedArchiveEntryCount).toBe(3);
    expect(result.fileGroups).toEqual([]);
    expect(result.archiveFileGroups).toEqual([{
      hash: 'member-hash',
      files: [
        expect.objectContaining({
          id: 'archive-old:meshes/body.stl',
          archiveFileId: 'archive-old',
          modelId: 'model-old',
          filename: 'body.stl',
          relativePath: 'meshes/body.stl',
        }),
        expect.objectContaining({
          id: 'archive-new:meshes/body.stl',
          archiveFileId: 'archive-new',
          modelId: 'model-new',
        }),
      ],
    }]);
  });

  it('skips an unreadable archive without failing the ordinary duplicate scan', async () => {
    const fixture = databaseReturning([], [], [archiveRow('model-1', 'broken-archive')]);
    const storage = {
      retrieveStream: vi.fn().mockRejectedValue(new Error('archive unavailable')),
    };
    const fileProcessing = { processArchive: vi.fn() };

    await expect(new DuplicateScannerService(
      fixture.database as never,
      storage as never,
      fileProcessing as never,
    ).scanDuplicates('library-1')).resolves.toMatchObject({
      scannedArchiveFileCount: 0,
      scannedArchiveEntryCount: 0,
      archiveFileGroups: [],
    });
    expect(fileProcessing.processArchive).not.toHaveBeenCalled();
  });

  it('excludes ignored whole-model fingerprints while retaining file-level candidates', async () => {
    const rows = [fileRow('first', 'shared'), fileRow('second', 'shared')];
    const initial = await new DuplicateScannerService(databaseReturning(rows).database as never)
      .scanDuplicates('library-1');
    const ignored = await new DuplicateScannerService(
      databaseReturning(rows, [initial.groups[0].fingerprint]).database as never,
    ).scanDuplicates('library-1');

    expect(ignored.groups).toEqual([]);
    expect(ignored.fileGroups).toHaveLength(1);
  });

  it.each(['markDuplicateFileGroup', 'ignoreDuplicateFileGroup'] as const)(
    'rejects a missing or stale group in %s',
    async (method) => {
      const fixture = databaseReturning([
        fileRow('first', 'shared'),
        fileRow('second', 'shared'),
      ]);
      const service = new DuplicateScannerService(fixture.database as never);

      await expect(service[method]('library-1', 'missing')).rejects.toMatchObject({
        code: ErrorCodes.NOT_FOUND,
        statusCode: 404,
        message: 'Duplicate file group not found',
      });
    },
  );

  it('revalidates current duplicate membership inside the mark-all update', async () => {
    const fixture = databaseReturning([]);
    const updates = withReconciliationUpdates(fixture.database);

    await new DuplicateScannerService(fixture.database as never).markDuplicates('library-1');

    const fileFlag = updates.getFileFlag();
    expect(fileFlag).toBeDefined();
    const query = new PgDialect().sqlToQuery(fileFlag!);
    expect(query.sql).toContain('duplicate_owner.status = \'ready\'');
    expect(query.sql).toContain('duplicate_model.status = \'ready\'');
    expect(query.sql).toContain('count(*)');
    expect(query.sql).toContain('duplicate_file_ignores');
    expect(query.params.filter((param) => param === 'library-1')).toHaveLength(3);
  });

  it('marks a selected current hash without relying on scanned file IDs', async () => {
    const fixture = databaseReturning([
      fileRow('first', 'shared'),
      fileRow('second', 'shared'),
    ]);
    const updates = withReconciliationUpdates(fixture.database);

    await new DuplicateScannerService(fixture.database as never)
      .markDuplicateFileGroup('library-1', 'shared');

    const query = new PgDialect().sqlToQuery(updates.getFileFlag()!);
    expect(query.params).toContain('shared');
    expect(query.params).not.toContain('first-shared');
    expect(query.params).not.toContain('second-shared');
  });

  it('retries user review actions in a serializable transaction', async () => {
    const fixture = databaseReturning([]);
    withReconciliationUpdates(fixture.database);
    const serializationFailure = Object.assign(new Error('serialization failure'), {
      code: '40001',
    });
    const transaction = vi.fn()
      .mockRejectedValueOnce(serializationFailure)
      .mockImplementationOnce((callback: (database: unknown) => Promise<unknown>) =>
        callback(fixture.database));
    Object.assign(fixture.database, { transaction });

    await new DuplicateScannerService(fixture.database as never).markDuplicates('library-1');

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenNthCalledWith(1, expect.any(Function), {
      isolationLevel: 'serializable',
    });
    expect(transaction).toHaveBeenNthCalledWith(2, expect.any(Function), {
      isolationLevel: 'serializable',
    });
  });
});
