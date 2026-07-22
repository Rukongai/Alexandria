import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/index.js', () => ({
  db: { transaction: vi.fn(), select: vi.fn() },
}));

import { db } from '../db/index.js';
import { AiProviderService } from './ai-provider.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROVIDER_ID = '22222222-2222-4222-8222-222222222222';
const REPLACEMENT_ID = '33333333-3333-4333-8333-333333333333';

function selectChain(rows: unknown[]) {
  const chain = { from: vi.fn(), where: vi.fn(), orderBy: vi.fn(), limit: vi.fn() };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockResolvedValue(rows);
  return chain;
}

function mutationChain(returningRows: unknown[] = []) {
  const chain = { values: vi.fn(), set: vi.fn(), where: vi.fn(), returning: vi.fn() };
  chain.values.mockReturnValue(chain);
  chain.set.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.returning.mockResolvedValue(returningRows);
  return chain;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: PROVIDER_ID,
    userId: USER_ID,
    name: 'Provider',
    baseUrl: 'https://provider.example/v1',
    model: 'model',
    apiKeyEncrypted: null,
    apiKeyHint: null,
    isDefault: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('AiProviderService default selection', () => {
  it('automatically makes the first provider the default', async () => {
    const insert = mutationChain([row()]);
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi.fn().mockReturnValue(selectChain([])),
      insert: vi.fn().mockReturnValue(insert),
      update: vi.fn(),
    };
    vi.mocked(db.transaction).mockImplementation(async (callback) => callback(tx as never));

    const result = await new AiProviderService(
      'secret',
      fetch,
      false,
      async () => [{ address: '93.184.216.34', family: 4 }],
    ).create(USER_ID, {
      name: 'Provider', baseUrl: 'https://provider.example/v1/', model: 'model',
    });

    expect(insert.values).toHaveBeenCalledWith(expect.objectContaining({ isDefault: true }));
    expect(result.isDefault).toBe(true);
  });

  it('promotes the oldest remaining provider when deleting the default', async () => {
    const remove = mutationChain();
    const promote = mutationChain();
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi.fn()
        .mockReturnValueOnce(selectChain([row()]))
        .mockReturnValueOnce(selectChain([{ id: REPLACEMENT_ID }])),
      delete: vi.fn().mockReturnValue(remove),
      update: vi.fn().mockReturnValue(promote),
    };
    vi.mocked(db.transaction).mockImplementation(async (callback) => callback(tx as never));

    await new AiProviderService('secret').delete(USER_ID, PROVIDER_ID);

    expect(promote.set).toHaveBeenCalledWith(expect.objectContaining({ isDefault: true }));
    expect(promote.where).toHaveBeenCalledOnce();
  });
});
