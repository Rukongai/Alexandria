/**
 * Bounded-concurrency helpers.
 *
 * Object stores charge a fixed round trip per request, so a loop that awaits
 * one upload before starting the next spends most of its wall time idle. These
 * helpers cap how many operations run at once without unbounded fan-out.
 */

/**
 * Run `fn` over every item with at most `limit` operations in flight, returning
 * results in input order.
 *
 * On failure no further items are started, but operations already in flight are
 * awaited before the first error is rethrown. Callers performing cleanup (for
 * example deleting partially written objects) therefore never race against an
 * upload that is still running.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('Concurrency limit must be a positive integer');
  }
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let firstError: unknown;

  async function worker(): Promise<void> {
    for (;;) {
      if (firstError !== undefined) return;

      const index = nextIndex++;
      if (index >= items.length) return;

      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        // Preserve the earliest failure; later ones are consequences of the
        // same batch failing and would only obscure the root cause.
        firstError ??= error ?? new Error('Unknown error');
        return;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );

  if (firstError !== undefined) throw firstError;
  return results;
}

/** `mapWithConcurrency` for callers that only need the side effects. */
export async function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  await mapWithConcurrency(items, limit, fn);
}
