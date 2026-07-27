import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./client', () => ({
  get: vi.fn(),
  post: vi.fn(),
}));

import { get, post } from './client';
import {
  ignoreDuplicateFileGroup,
  markDuplicateFileGroup,
  markDuplicates,
  scanDuplicates,
} from './tools';

const envelope = <T,>(data: T) => ({ data, meta: null, errors: null });

describe('duplicate tools API', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should unwrap duplicate scan results', async () => {
    const result = {
      scannedModelCount: 0,
      scannedFileCount: 0,
      scannedArchiveFileCount: 0,
      scannedArchiveEntryCount: 0,
      redundantModelCount: 0,
      redundantFileCount: 0,
      reclaimableBytes: 0,
      fileReclaimableBytes: 0,
      groups: [],
      fileGroups: [],
      archiveFileGroups: [],
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

  it('should mark one duplicate file group using its encoded hash', async () => {
    const result = { markedFileCount: 2, markedModelCount: 1 };
    vi.mocked(post).mockResolvedValue(envelope(result));

    await expect(markDuplicateFileGroup('hash/with spaces')).resolves.toEqual(result);
    expect(post).toHaveBeenCalledWith(
      '/tools/duplicates/file-groups/hash%2Fwith%20spaces/mark',
    );
  });

  it('should ignore one duplicate file group using its encoded hash', async () => {
    const result = { ignoredFileGroupCount: 1, ignoredModelGroupCount: 0 };
    vi.mocked(post).mockResolvedValue(envelope(result));

    await expect(ignoreDuplicateFileGroup('hash/with spaces')).resolves.toEqual(result);
    expect(post).toHaveBeenCalledWith(
      '/tools/duplicates/file-groups/hash%2Fwith%20spaces/ignore',
    );
  });
});
