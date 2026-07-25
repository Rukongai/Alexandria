import { describe, expect, it, vi } from 'vitest';
import { DuplicateScannerService } from './duplicate-scanner.service.js';

interface CandidateRow {
  id: string;
  name: string;
  originalFilename: string | null;
  totalSizeBytes: number;
  createdAt: Date;
  hashes: string[];
}

function databaseReturning(rows: CandidateRow[]) {
  const query = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    groupBy: vi.fn(),
    orderBy: vi.fn(),
  };
  query.from.mockReturnValue(query);
  query.innerJoin.mockReturnValue(query);
  query.where.mockReturnValue(query);
  query.groupBy.mockReturnValue(query);
  query.orderBy.mockResolvedValue(rows);

  return {
    database: { select: vi.fn().mockReturnValue(query) },
    query,
  };
}

function row(
  id: string,
  hashes: string[],
  options: {
    name?: string;
    originalFilename?: string | null;
    totalSizeBytes?: number;
    createdAt?: string;
  } = {},
): CandidateRow {
  return {
    id,
    hashes,
    name: options.name ?? id,
    originalFilename: options.originalFilename ?? `${id}.zip`,
    totalSizeBytes: options.totalSizeBytes ?? 100,
    createdAt: new Date(options.createdAt ?? '2026-01-01T00:00:00.000Z'),
  };
}

describe('DuplicateScannerService', () => {
  it('matches only complete sorted hash multisets and preserves multiplicity', async () => {
    const { database, query } = databaseReturning([
      row('new-copy', ['hash-a', 'hash-b'], {
        name: 'Renamed copy',
        originalFilename: 'different-source.7z',
        totalSizeBytes: 120,
        createdAt: '2026-02-01T00:00:00.000Z',
      }),
      row('old-copy', ['hash-a', 'hash-b'], {
        name: 'Original',
        originalFilename: 'original.zip',
        totalSizeBytes: 100,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      row('single-a', ['hash-a']),
      row('repeated-a', ['hash-a', 'hash-a']),
    ]);
    const service = new DuplicateScannerService(database as never);

    const result = await service.scanDuplicates('library-1');

    expect(database.select).toHaveBeenCalledOnce();
    expect(query.innerJoin).toHaveBeenCalledOnce();
    expect(query.where).toHaveBeenCalledOnce();
    expect(query.groupBy).toHaveBeenCalledOnce();
    expect(result).toEqual({
      scannedModelCount: 4,
      groups: [
        {
          fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          fileCount: 2,
          models: [
            {
              id: 'old-copy',
              name: 'Original',
              originalFilename: 'original.zip',
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
      ],
    });
  });

  it('returns stable ordering for models and groups regardless of row order', async () => {
    const rows = [
      row('group-b-new', ['hash-z'], { createdAt: '2026-04-01T00:00:00.000Z' }),
      row('group-a-new', ['hash-a'], { createdAt: '2026-03-01T00:00:00.000Z' }),
      row('group-b-old', ['hash-z'], { createdAt: '2026-02-01T00:00:00.000Z' }),
      row('group-a-old', ['hash-a'], { createdAt: '2026-01-01T00:00:00.000Z' }),
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
  });

  it('coalesces concurrent scans for the same library', async () => {
    const fixture = databaseReturning([row('only-model', ['hash-a'])]);
    const service = new DuplicateScannerService(fixture.database as never);

    const [first, second] = await Promise.all([
      service.scanDuplicates('library-1'),
      service.scanDuplicates('library-1'),
    ]);

    expect(first).toEqual(second);
    expect(fixture.database.select).toHaveBeenCalledOnce();
  });

  it('does not scan or group models without files', async () => {
    const { database } = databaseReturning([]);

    await expect(new DuplicateScannerService(database as never).scanDuplicates('library-1'))
      .resolves.toEqual({ scannedModelCount: 0, groups: [] });
  });
});
