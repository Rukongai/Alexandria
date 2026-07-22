import { beforeEach, describe, expect, it, vi } from 'vitest';

const queueMocks = vi.hoisted(() => ({
  add: vi.fn(),
  getJob: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: vi.fn(function Queue() {
    return {
      add: queueMocks.add,
      getJob: queueMocks.getJob,
    };
  }),
}));

import {
  JobService,
  parseImportCommitProgress,
  type CommitJobPayload,
} from './job.service.js';

const validProgress = {
  phase: 'storing_files' as const,
  percent: 40,
  completedFiles: 1,
  totalFiles: 3,
  completedBytes: 50,
  totalBytes: 100,
  currentFilename: 'part.stl',
};

describe('JobService import commit progress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should use the import session id as the deterministic commit job id', async () => {
    queueMocks.add.mockResolvedValue({ id: 'session-1' });
    const service = new JobService();
    const payload: CommitJobPayload = {
      sessionId: 'session-1',
      modelId: 'model-1',
      userId: 'user-1',
      libraryId: 'library-1',
    };

    await expect(service.enqueueCommitJob(payload)).resolves.toBe('session-1');

    expect(queueMocks.add).toHaveBeenCalledWith('commit', payload, { jobId: 'session-1' });
  });

  it('should return only valid structured progress from the commit queue', async () => {
    queueMocks.getJob.mockResolvedValue({ progress: validProgress });
    const service = new JobService();

    await expect(service.getImportCommitProgress('session-1')).resolves.toEqual(validProgress);
    expect(queueMocks.getJob).toHaveBeenCalledWith('session-1');
  });

  it.each([
    50,
    null,
    { ...validProgress, phase: 'unknown' },
    { ...validProgress, percent: 101 },
    { ...validProgress, completedFiles: 4 },
    { ...validProgress, completedBytes: 101 },
    { ...validProgress, currentFilename: 42 },
  ])('should reject malformed BullMQ progress value %#', (value) => {
    expect(parseImportCommitProgress(value)).toBeNull();
  });
});
