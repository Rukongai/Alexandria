import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./client', () => ({
  get: vi.fn(),
  post: vi.fn(),
}));

import { get, post } from './client';
import { ignoreDuplicates, markDuplicates, scanDuplicates } from './tools';

const envelope = <T,>(data: T) => ({ data, meta: null, errors: null });

describe('duplicate tools API', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should unwrap duplicate scan results', async () => {
    const result = {
      scannedModelCount: 0,
      scannedFileCount: 0,
      redundantModelCount: 0,
      redundantFileCount: 0,
      reclaimableBytes: 0,
      fileReclaimableBytes: 0,
      groups: [],
      fileGroups: [],
    };
    vi.mocked(get).mockResolvedValue(envelope(result));

    await expect(scanDuplicates()).resolves.toEqual(result);
    expect(get).toHaveBeenCalledWith('/tools/duplicates');
  });

  it('should mark duplicates with a bodyless request and unwrap the counts', async () => {
    const result = { markedFileCount: 4, markedModelCount: 2 };
    vi.mocked(post).mockResolvedValue(envelope(result));

    await expect(markDuplicates()).resolves.toEqual(result);
    expect(post).toHaveBeenCalledWith('/tools/duplicates/mark');
  });

  it('should ignore duplicates with a bodyless request and unwrap the group counts', async () => {
    const result = { ignoredFileGroupCount: 3, ignoredModelGroupCount: 1 };
    vi.mocked(post).mockResolvedValue(envelope(result));

    await expect(ignoreDuplicates()).resolves.toEqual(result);
    expect(post).toHaveBeenCalledWith('/tools/duplicates/ignore');
  });
});
