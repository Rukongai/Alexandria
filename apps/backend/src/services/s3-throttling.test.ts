import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isThrottlingError, observeThrottling } from './s3-throttling.js';

type Middleware = (next: (args: unknown) => Promise<unknown>) => (
  args: unknown,
) => Promise<unknown>;

/**
 * Stands in for the SDK middleware stack, capturing the registered middleware
 * so a test can drive it the way the retry loop would.
 */
class FakeMiddlewareStack {
  middleware: Middleware | null = null;
  options: { relation?: string; toMiddleware?: string; name?: string } | null = null;

  addRelativeTo(
    middleware: Middleware,
    options: { relation?: string; toMiddleware?: string; name?: string },
  ): void {
    this.middleware = middleware;
    this.options = options;
  }

  /** Run one attempt whose handler rejects with `error`. */
  async attempt(error: unknown): Promise<unknown> {
    const handler = this.middleware!(() => Promise.reject(error));
    return handler({});
  }

  async succeed(): Promise<unknown> {
    const handler = this.middleware!(() => Promise.resolve('ok'));
    return handler({});
  }
}

function throttled(name = 'SlowDown', httpStatusCode = 503): Error {
  return Object.assign(new Error('Please reduce your request rate.'), {
    name,
    $metadata: { httpStatusCode },
  });
}

function observed(): {
  stack: FakeMiddlewareStack;
  reports: { count: number }[];
  advance: (ms: number) => void;
} {
  const stack = new FakeMiddlewareStack();
  const reports: { count: number }[] = [];
  let clock = 100_000;

  observeThrottling({ middlewareStack: stack } as never, {
    now: () => clock,
    intervalMs: 30_000,
    onThrottle: (count) => reports.push({ count }),
  });

  return { stack, reports, advance: (ms: number) => void (clock += ms) };
}

describe('isThrottlingError', () => {
  it('should recognize the SlowDown code providers use for rate limiting', () => {
    expect(isThrottlingError(throttled('SlowDown'))).toBe(true);
  });

  it('should recognize other throttling names and any 429', () => {
    expect(isThrottlingError(throttled('ThrottlingException', 400))).toBe(true);
    expect(isThrottlingError(throttled('TooManyRequestsException', 400))).toBe(true);
    expect(isThrottlingError(throttled('Whatever', 429))).toBe(true);
  });

  it('should not treat a bare 503 as throttling', () => {
    // A 503 without a throttling name is an outage, and calling it throttling
    // would tell an operator to reduce concurrency during a provider incident.
    expect(isThrottlingError(throttled('ServiceUnavailable', 503))).toBe(false);
  });

  it('should not treat ordinary failures as throttling', () => {
    expect(isThrottlingError(throttled('NoSuchKey', 404))).toBe(false);
    expect(isThrottlingError(new Error('socket hang up'))).toBe(false);
    expect(isThrottlingError(undefined)).toBe(false);
    expect(isThrottlingError('SlowDown')).toBe(false);
  });
});

describe('observeThrottling', () => {
  it('should wrap the deserializer, which is what raises a throttling error', () => {
    const { stack } = observed();

    // Nearer the wire than this and the middleware sees a plain 503 response
    // object with nothing thrown to catch. Verified end to end below.
    expect(stack.options).toMatchObject({
      relation: 'before',
      toMiddleware: 'deserializerMiddleware',
    });
  });

  it('should report the first throttled attempt immediately', async () => {
    const { stack, reports } = observed();

    await expect(stack.attempt(throttled())).rejects.toThrow();

    expect(reports).toEqual([{ count: 1 }]);
  });

  it('should re-raise the error so the retry strategy still handles it', async () => {
    const { stack } = observed();
    const error = throttled();

    await expect(stack.attempt(error)).rejects.toBe(error);
  });

  it('should collapse sustained throttling into one report per interval', async () => {
    const { stack, reports, advance } = observed();

    await expect(stack.attempt(throttled())).rejects.toThrow();
    for (let i = 0; i < 5; i += 1) {
      advance(1_000);
      await expect(stack.attempt(throttled())).rejects.toThrow();
    }

    expect(reports).toEqual([{ count: 1 }]);

    advance(30_000);
    await expect(stack.attempt(throttled())).rejects.toThrow();

    // The quiet attempts are counted, not discarded: 5 suppressed plus this one.
    expect(reports).toEqual([{ count: 1 }, { count: 6 }]);
  });

  it('should ignore failures that are not throttling', async () => {
    const { stack, reports } = observed();

    await expect(stack.attempt(throttled('NoSuchKey', 404))).rejects.toThrow();

    expect(reports).toEqual([]);
  });

  it('should pass successful attempts through untouched', async () => {
    const { stack, reports } = observed();

    await expect(stack.succeed()).resolves.toBe('ok');

    expect(reports).toEqual([]);
  });

  it('should not swallow a throttling error into a resolved response', async () => {
    const stack = new FakeMiddlewareStack();
    const onThrottle = vi.fn();
    observeThrottling({ middlewareStack: stack } as never, { onThrottle });

    const result = stack.attempt(throttled());

    await expect(result).rejects.toMatchObject({ name: 'SlowDown' });
    expect(onThrottle).toHaveBeenCalledOnce();
  });
});

/**
 * The tests above drive a stand-in stack, which cannot show that the chosen
 * middleware step is the right one. These run a real S3 client against a server
 * that only ever answers `SlowDown`.
 */
describe('observeThrottling against a real S3 client', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = null;
  });

  async function throttlingEndpoint(): Promise<{ url: string; requests: () => number }> {
    let requests = 0;
    server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(503, { 'content-type': 'application/xml' });
      response.end(
        '<?xml version="1.0" encoding="UTF-8"?><Error><Code>SlowDown</Code>' +
          '<Message>Please reduce your request rate.</Message></Error>',
      );
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server!.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, requests: () => requests };
  }

  it('should observe every throttled attempt the SDK makes', async () => {
    const { url, requests } = await throttlingEndpoint();
    const onThrottle = vi.fn();
    const client = new S3Client({
      endpoint: url,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      retryMode: 'adaptive',
      maxAttempts: 3,
    });
    // Report every occurrence so the count is comparable to the attempt count.
    observeThrottling(client, { intervalMs: 0, onThrottle });

    await expect(
      client.send(new GetObjectCommand({ Bucket: 'bucket', Key: 'object' })),
    ).rejects.toMatchObject({ name: 'SlowDown' });

    // The SDK retried, and the observer saw each attempt rather than only the
    // final failure — which is what registering below the retry step buys.
    expect(requests()).toBe(3);
    expect(onThrottle).toHaveBeenCalledTimes(3);
  }, 20_000);
});
