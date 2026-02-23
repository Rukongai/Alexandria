import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ErrorCodes } from '@alexandria/shared';

// ---------------------------------------------------------------------------
// Mock the db module before importing the service so the singleton never
// tries to connect to a real database.
// ---------------------------------------------------------------------------
vi.mock('../db/index.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

// Import after mock is registered
import { ModelService } from './model.service.js';
import { db } from '../db/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal drizzle-style fluent chain that resolves to `rows`. */
function buildSelectChain(rows: unknown[]) {
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  // limit() resolves the query – return the rows array
  chain.limit.mockResolvedValue(rows);
  return chain;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ModelService – getModelById', () => {
  let service: ModelService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ModelService();
  });

  it('should throw NOT_FOUND when model does not exist', async () => {
    // db.select() starts the chain; simulate a query returning no rows
    vi.mocked(db.select).mockReturnValue(buildSelectChain([]) as unknown as ReturnType<typeof db.select>);

    await expect(service.getModelById('non-existent-id')).rejects.toMatchObject({
      name: 'AppError',
      code: ErrorCodes.NOT_FOUND,
      statusCode: 404,
    });
  });

  it('should return model when it exists', async () => {
    const fakeModel = {
      id: 'abc-123',
      name: 'My Model',
      slug: 'my-model-xxxx',
      userId: 'user-1',
      status: 'ready',
      sourceType: 'zip_upload',
      originalFilename: 'my-model.zip',
      totalSizeBytes: 1024,
      fileCount: 3,
      fileHash: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    vi.mocked(db.select).mockReturnValue(
      buildSelectChain([fakeModel]) as unknown as ReturnType<typeof db.select>,
    );

    const result = await service.getModelById('abc-123');
    expect(result).toEqual(fakeModel);
  });
});
