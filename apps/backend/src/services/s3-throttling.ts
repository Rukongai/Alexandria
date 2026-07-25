/**
 * Throttling visibility for the S3 client.
 *
 * Providers answer a request rate they will not serve with a distinct error
 * rather than a slow response: `SlowDown` on MEGA S4, `Throttling` and friends
 * elsewhere. The SDK retries those internally, so a throttled deployment looks
 * healthy from the outside — uploads still succeed, just slower — and there is
 * nothing in the logs to explain it.
 *
 * This records every throttled attempt, including the ones a retry rescues, so
 * "are we hitting the rate limit?" is answerable from the logs. It observes
 * only; backing off is the retry strategy's job.
 *
 * @see https://help.mega.io/megas4/setup-guides/mega-s4-rate-limits-and-performance-guidance
 */

import type { S3Client } from '@aws-sdk/client-s3';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('S3Throttling');

/**
 * Error names providers use to mean "you are going too fast".
 *
 * Mirrors the SDK's own throttling classification, which is not exported in a
 * form usable here.
 */
const THROTTLING_ERROR_NAMES = new Set([
  'SlowDown',
  'Throttling',
  'ThrottlingException',
  'ThrottledException',
  'RequestThrottled',
  'RequestThrottledException',
  'TooManyRequestsException',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
  'BandwidthLimitExceeded',
  'EC2ThrottledException',
]);

/** Sustained throttling would otherwise emit a line per retried attempt. */
export const THROTTLE_LOG_INTERVAL_MS = 30_000;

export function isThrottlingError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  if (candidate.name && THROTTLING_ERROR_NAMES.has(candidate.name)) return true;
  // 429 always means throttled. 503 does not on its own — it is also a genuine
  // outage — so it counts only alongside a name the provider throttles with.
  return candidate.$metadata?.httpStatusCode === 429;
}

export interface ThrottleObserverOptions {
  now?: () => number;
  intervalMs?: number;
  onThrottle?: (count: number, error: unknown) => void;
}

/**
 * Count throttled attempts on `client`, logging a summary at most once per
 * interval.
 *
 * Placed immediately outside `deserializerMiddleware`, which is what turns a
 * throttled HTTP response into a thrown `SlowDown`. Anything nearer the wire
 * than the deserializer only sees an unremarkable 503 response object and
 * catches nothing; anything outside the retry middleware sees one error per
 * request instead of one per attempt, hiding every throttle a retry rescued.
 */
export function observeThrottling(
  client: Pick<S3Client, 'middlewareStack'>,
  options: ThrottleObserverOptions = {},
): void {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? THROTTLE_LOG_INTERVAL_MS;
  const report =
    options.onThrottle ??
    ((count: number, error: unknown) => {
      logger.warn(
        { throttledAttempts: count, err: (error as Error)?.message },
        'S3 provider is throttling requests; the client is backing off. ' +
          'Sustained throttling means upload concurrency is above what the provider will serve.',
      );
    });

  let sinceLastReport = 0;
  let lastReportedAt = 0;

  client.middlewareStack.addRelativeTo(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- middleware is untyped at this seam
    (next: any) => async (args: any) => {
      try {
        return await next(args);
      } catch (error) {
        if (isThrottlingError(error)) {
          sinceLastReport += 1;
          const timestamp = now();
          if (timestamp - lastReportedAt >= intervalMs) {
            lastReportedAt = timestamp;
            const count = sinceLastReport;
            sinceLastReport = 0;
            report(count, error);
          }
        }
        throw error;
      }
    },
    {
      relation: 'before',
      toMiddleware: 'deserializerMiddleware',
      name: 'alexandriaThrottleObserver',
      override: true,
    },
  );
}
