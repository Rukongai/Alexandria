import { describe, expect, it } from 'vitest';
import { forEachWithConcurrency, mapWithConcurrency } from './concurrency.js';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('mapWithConcurrency', () => {
  it('returns results in input order regardless of completion order', async () => {
    const results = await mapWithConcurrency([30, 10, 20, 0], 4, async (delay, index) => {
      // Later items finish first, so input order cannot be an accident of timing.
      await new Promise((resolve) => setTimeout(resolve, delay));
      return `${index}:${delay}`;
    });

    expect(results).toEqual(['0:30', '1:10', '2:20', '3:0']);
  });

  it('never exceeds the requested concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const release: Array<() => void> = [];

    const pending = mapWithConcurrency(Array.from({ length: 20 }), 5, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => release.push(resolve));
      inFlight -= 1;
      return null;
    });

    await flush();
    expect(peak).toBe(5);

    // Drain in waves so the pool refills rather than running everything at once.
    while (release.length > 0) {
      release.splice(0).forEach((resolve) => resolve());
      await flush();
    }
    await pending;
    expect(peak).toBe(5);
  });

  it('runs sequentially at a limit of one', async () => {
    const order: number[] = [];
    await mapWithConcurrency([1, 2, 3], 1, async (item) => {
      order.push(item);
      await flush();
      order.push(-item);
      return item;
    });

    expect(order).toEqual([1, -1, 2, -2, 3, -3]);
  });

  it('stops starting new work once an item fails', async () => {
    const started: number[] = [];

    await expect(
      mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 2, async (item) => {
        started.push(item);
        if (item === 1) throw new Error('boom');
        await flush();
        return item;
      }),
    ).rejects.toThrow('boom');

    // The two initial workers start, but the queue is not drained afterwards.
    expect(started.length).toBeLessThan(8);
  });

  it('waits for in-flight work before surfacing the failure', async () => {
    let settled = false;
    let release = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const pending = mapWithConcurrency([1, 2], 2, async (item) => {
      if (item === 1) throw new Error('first fails');
      await blocked;
      settled = true;
      return item;
    });
    const assertion = expect(pending).rejects.toThrow('first fails');

    await flush();
    // The rejection must not surface while the second item is still running,
    // or a caller's cleanup would race against an upload still in progress.
    expect(settled).toBe(false);

    release();
    await assertion;
    expect(settled).toBe(true);
  });

  it('reports the first failure when several items fail', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 3, async (item) => {
        await new Promise((resolve) => setTimeout(resolve, item));
        throw new Error(`failure ${item}`);
      }),
    ).rejects.toThrow('failure 1');
  });

  it('handles an empty list without invoking the callback', async () => {
    let calls = 0;
    await expect(
      mapWithConcurrency([], 4, async () => {
        calls += 1;
        return null;
      }),
    ).resolves.toEqual([]);
    expect(calls).toBe(0);
  });

  it('rejects a limit that would stall or misbehave', async () => {
    await expect(mapWithConcurrency([1], 0, async () => null)).rejects.toThrow(
      'Concurrency limit must be a positive integer',
    );
    await expect(mapWithConcurrency([1], -3, async () => null)).rejects.toThrow();
    await expect(mapWithConcurrency([1], 1.5, async () => null)).rejects.toThrow();
  });

  it('propagates a thrown non-Error value without losing the failure', async () => {
    await expect(
      mapWithConcurrency([1], 1, async () => {
        throw undefined;
      }),
    ).rejects.toThrow('Unknown error');
  });
});

describe('forEachWithConcurrency', () => {
  it('visits every item', async () => {
    const seen: number[] = [];
    await forEachWithConcurrency([1, 2, 3, 4], 2, async (item) => {
      seen.push(item);
    });

    expect(seen.sort()).toEqual([1, 2, 3, 4]);
  });
});
