import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./client', () => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
  putRaw: vi.fn(),
  postForm: vi.fn(),
}));

import { del, post, putRaw } from './client';
import { scanMultipartUpload } from './models';

const envelope = <T,>(data: T) => ({ data, meta: null, errors: null });

describe('scanMultipartUpload', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should init and upload every member before completing one group', async () => {
    const files = [
      new File(['aaaa'], 'one.zip'),
      new File(['bbbb'], 'two.zip'),
    ];
    const progress: number[] = [];
    const events: string[] = [];
    let initCount = 0;

    vi.mocked(post).mockImplementation(async (path) => {
      if (path === '/models/upload/multipart/init') {
        initCount += 1;
        events.push(`init-${initCount}`);
        return envelope({
          uploadId: `upload-${initCount}`,
          expiresAt: '2026-07-22T12:00:00.000Z',
        });
      }
      events.push('complete');
      return envelope({ sessionId: 'session-1' });
    });
    vi.mocked(putRaw).mockImplementation(async (path, _chunk, onChunkProgress) => {
      events.push(`chunk-${path.includes('upload-1') ? '1' : '2'}`);
      onChunkProgress?.(50);
      onChunkProgress?.(100);
      return envelope({ received: 4 });
    });

    const result = await scanMultipartUpload(files, 'combine', (pct) => progress.push(pct));

    expect(result).toEqual({ sessionId: 'session-1' });
    expect(vi.mocked(post).mock.calls).toEqual([
      ['/models/upload/multipart/init', { filename: 'one.zip', totalSize: 4, totalChunks: 1 }],
      ['/models/upload/multipart/init', { filename: 'two.zip', totalSize: 4, totalChunks: 1 }],
      ['/models/upload/multipart/complete', {
        uploadIds: ['upload-1', 'upload-2'],
        mode: 'combine',
      }],
    ]);
    expect(vi.mocked(putRaw).mock.calls.map(([path]) => path)).toEqual([
      '/models/upload/upload-1/chunk/0',
      '/models/upload/upload-2/chunk/0',
    ]);
    expect(events).toEqual(['init-1', 'chunk-1', 'init-2', 'chunk-2', 'complete']);
    expect(progress[0]).toBe(0);
    expect(progress).toContain(24);
    expect(progress).toContain(71);
    expect(progress.at(-1)).toBe(100);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it('should reject a one-file group before making API requests', async () => {
    await expect(scanMultipartUpload([new File(['a'], 'one.zip')], 'combine'))
      .rejects.toThrow('Choose between 2 and 100 archive files.');
    expect(post).not.toHaveBeenCalled();
    expect(putRaw).not.toHaveBeenCalled();
  });

  it('should complete a split group using the IDs returned for all members', async () => {
    vi.mocked(post)
      .mockResolvedValueOnce(envelope({
        uploadId: 'part-1',
        expiresAt: '2026-07-22T12:00:00.000Z',
      }))
      .mockResolvedValueOnce(envelope({
        uploadId: 'part-2',
        expiresAt: '2026-07-22T12:00:00.000Z',
      }))
      .mockResolvedValueOnce(envelope({ sessionId: 'split-session' }));
    vi.mocked(putRaw).mockResolvedValue(envelope({ received: 1 }));

    await expect(scanMultipartUpload([
      new File(['a'], 'dragon.z01'),
      new File(['b'], 'dragon.zip'),
    ], 'split')).resolves.toEqual({ sessionId: 'split-session' });

    expect(post).toHaveBeenLastCalledWith('/models/upload/multipart/complete', {
      uploadIds: ['part-1', 'part-2'],
      mode: 'split',
    });
  });

  it('should reject groups above 100 files and empty members before making API requests', async () => {
    const tooMany = Array.from(
      { length: 101 },
      (_, index) => new File(['a'], `archive-${index}.zip`),
    );
    await expect(scanMultipartUpload(tooMany, 'combine'))
      .rejects.toThrow('Choose between 2 and 100 archive files.');
    await expect(scanMultipartUpload([
      new File([], 'one.zip'),
      new File([], 'two.zip'),
    ], 'combine')).rejects.toThrow('Archive files cannot be empty.');

    expect(post).not.toHaveBeenCalled();
    expect(putRaw).not.toHaveBeenCalled();
  });

  it('should clean up initialized members when a later init fails', async () => {
    const originalError = new Error('second init failed');
    vi.mocked(post)
      .mockResolvedValueOnce(envelope({
        uploadId: 'initialized-1',
        expiresAt: '2026-07-22T12:00:00.000Z',
      }))
      .mockRejectedValueOnce(originalError);
    vi.mocked(putRaw).mockResolvedValue(envelope({ received: 1 }));
    vi.mocked(del).mockResolvedValue(envelope(null));

    await expect(scanMultipartUpload([
      new File(['a'], 'one.zip'),
      new File(['b'], 'two.zip'),
    ], 'combine')).rejects.toBe(originalError);

    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith('/models/upload/initialized-1');
  });

  it('should preserve the first init error without attempting an undefined abort', async () => {
    const originalError = new Error('first init failed');
    vi.mocked(post).mockRejectedValueOnce(originalError);

    await expect(scanMultipartUpload([
      new File(['a'], 'one.zip'),
      new File(['b'], 'two.zip'),
    ], 'combine')).rejects.toBe(originalError);

    expect(putRaw).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('should clean up the initialized member when chunk retries are exhausted', async () => {
    vi.useFakeTimers();
    const originalError = new Error('chunk failed');
    vi.mocked(post).mockResolvedValue(envelope({
      uploadId: 'chunk-failure',
      expiresAt: '2026-07-22T12:00:00.000Z',
    }));
    vi.mocked(putRaw).mockRejectedValue(originalError);
    vi.mocked(del).mockResolvedValue(envelope(null));

    try {
      const upload = scanMultipartUpload([
        new File(['a'], 'one.zip'),
        new File(['b'], 'two.zip'),
      ], 'combine');
      const rejection = expect(upload).rejects.toBe(originalError);
      await vi.runAllTimersAsync();
      await rejection;

      expect(putRaw).toHaveBeenCalledTimes(3);
      expect(del).toHaveBeenCalledWith('/models/upload/chunk-failure');
    } finally {
      vi.useRealTimers();
    }
  });

  it('should clean up every member and preserve the original complete error', async () => {
    const originalError = new Error('complete failed');
    vi.mocked(post)
      .mockResolvedValueOnce(envelope({
        uploadId: 'initialized-1',
        expiresAt: '2026-07-22T12:00:00.000Z',
      }))
      .mockResolvedValueOnce(envelope({
        uploadId: 'initialized-2',
        expiresAt: '2026-07-22T12:00:00.000Z',
      }))
      .mockRejectedValueOnce(originalError);
    vi.mocked(putRaw).mockResolvedValue(envelope({ received: 1 }));
    vi.mocked(del)
      .mockResolvedValueOnce(envelope(null))
      .mockRejectedValueOnce(new Error('cleanup also failed'));

    await expect(scanMultipartUpload([
      new File(['a'], 'one.zip'),
      new File(['b'], 'two.zip'),
    ], 'combine')).rejects.toBe(originalError);

    expect(vi.mocked(del).mock.calls).toEqual([
      ['/models/upload/initialized-1'],
      ['/models/upload/initialized-2'],
    ]);
  });
});
