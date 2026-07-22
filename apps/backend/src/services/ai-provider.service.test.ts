import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('../db/index.js', () => ({
  db: {
    select: vi.fn(),
    transaction: vi.fn(),
  },
}));

import { db } from '../db/index.js';
import {
  AiProviderService,
  assertSafeProviderUrl,
  decryptAiSecret,
  encryptAiSecret,
  normalizeAiBaseUrl,
} from './ai-provider.service.js';

function selectRows(rows: unknown[]) {
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockResolvedValue(rows);
  chain.limit.mockResolvedValue(rows);
  return chain;
}

const providerRow = {
  id: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  name: 'Private provider',
  baseUrl: 'https://provider.example/v1',
  model: 'example-model',
  apiKeyEncrypted: 'v1:secret-ciphertext-that-must-not-leak',
  apiKeyHint: '••••7890',
  isDefault: true,
  createdAt: new Date('2026-07-21T10:00:00.000Z'),
  updatedAt: new Date('2026-07-21T11:00:00.000Z'),
};

describe('AiProviderService public provider contract', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should expose secret presence and hint without returning encrypted credentials', async () => {
    vi.mocked(db.select).mockReturnValue(selectRows([providerRow]) as never);
    const service = new AiProviderService('test-encryption-secret');

    const result = await service.list(providerRow.userId);

    expect(result).toEqual([{
      id: providerRow.id,
      name: providerRow.name,
      baseUrl: providerRow.baseUrl,
      model: providerRow.model,
      isDefault: true,
      hasApiKey: true,
      apiKeyHint: '••••7890',
      createdAt: '2026-07-21T10:00:00.000Z',
      updatedAt: '2026-07-21T11:00:00.000Z',
    }]);
    expect(result[0]).not.toHaveProperty('apiKey');
    expect(result[0]).not.toHaveProperty('apiKeyEncrypted');
  });

  it('should return not found when a provider is not owned by the requesting user', async () => {
    vi.mocked(db.select).mockReturnValue(selectRows([]) as never);
    const service = new AiProviderService('test-encryption-secret');

    await expect(service.resolveConnection(
      '33333333-3333-4333-8333-333333333333',
      providerRow.id,
    )).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('AI provider credential encryption', () => {
  it('should decrypt only with the same server secret', () => {
    const encrypted = encryptAiSecret('sk-private-value', 'server-secret');

    expect(encrypted).not.toContain('sk-private-value');
    expect(decryptAiSecret(encrypted, 'server-secret')).toBe('sk-private-value');
    expect(() => decryptAiSecret(encrypted, 'different-secret')).toThrowError(
      expect.objectContaining({ code: 'INTERNAL_ERROR' }),
    );
  });
});

describe('AI provider outbound request hardening', () => {
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const connection = {
    id: providerRow.id,
    baseUrl: providerRow.baseUrl,
    model: providerRow.model,
    apiKey: null,
  };

  it('rejects embedded URL credentials', () => {
    expect(() => normalizeAiBaseUrl('https://user:password@provider.example/v1'))
      .toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  it('blocks private addresses unless explicitly enabled', async () => {
    const loopbackLookup = async () => [{ address: '127.0.0.1', family: 4 }];
    await expect(assertSafeProviderUrl('http://ollama.local:11434/v1', false, loopbackLookup))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(assertSafeProviderUrl('http://ollama.local:11434/v1', true, loopbackLookup))
      .resolves.toBeUndefined();
  });

  it('requires https for public providers while permitting opted-in local http', async () => {
    await expect(assertSafeProviderUrl('http://provider.example/v1', false, publicLookup))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(assertSafeProviderUrl('https://provider.example/v1', false, publicLookup))
      .resolves.toBeUndefined();
    await expect(assertSafeProviderUrl(
      'http://localhost:11434/v1',
      true,
      async () => [{ address: '127.0.0.1', family: 4 }],
    )).resolves.toBeUndefined();
  });

  it('always blocks link-local metadata targets even with private URLs enabled', async () => {
    await expect(assertSafeProviderUrl(
      'http://metadata.test/v1',
      true,
      async () => [{ address: '169.254.169.254', family: 4 }],
    )).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(assertSafeProviderUrl('http://metadata.google.internal/v1', true, publicLookup))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    for (const address of ['fd00:ec2::254', 'fd20:ce::254']) {
      await expect(assertSafeProviderUrl(
        'http://metadata-v6.test/v1',
        true,
        async () => [{ address, family: 6 }],
      )).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
  });

  it('blocks IPv4-embedded translation and transition address bypasses', async () => {
    for (const address of [
      '::ffff:a9fe:a9fe',
      '::ffff:0:a9fe:a9fe',
      '::a9fe:a9fe',
      '64:ff9b::a9fe:a9fe',
      '64:ff9b:1::a9fe:a9fe',
      '2002:a9fe:a9fe::',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    ]) {
      await expect(assertSafeProviderUrl(`https://[${address}]/v1`, true))
        .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }

    await expect(assertSafeProviderUrl('https://[::ffff:5db8:d822]/v1', false))
      .resolves.toBeUndefined();
  });

  it('pins the fetch dispatcher to the vetted address while preserving the provider URL', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const dispatcher = { close };
    const dispatcherFactory = vi.fn().mockReturnValue(dispatcher);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
    })));
    const service = new AiProviderService(
      'secret',
      fetchMock,
      false,
      async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      ],
      dispatcherFactory,
    );

    await service.createChatCompletion(connection, { messages: [] });

    expect(dispatcherFactory).toHaveBeenCalledWith([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);
    expect(fetchMock.mock.calls[0][0]).toEqual(new URL(`${connection.baseUrl}/chat/completions`));
    expect(fetchMock.mock.calls[0][1].dispatcher).toBe(dispatcher);
    expect(close).toHaveBeenCalledOnce();
  });

  it('re-resolves and pins every same-origin redirect hop', async () => {
    const lookupAll = vi.fn()
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '93.184.216.35', family: 4 }]);
    const dispatchers = [
      { close: vi.fn().mockResolvedValue(undefined) },
      { close: vi.fn().mockResolvedValue(undefined) },
    ];
    const dispatcherFactory = vi.fn()
      .mockReturnValueOnce(dispatchers[0])
      .mockReturnValueOnce(dispatchers[1]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 307,
        headers: { location: '/v1/redirected-chat' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
      })));
    const service = new AiProviderService(
      'secret',
      fetchMock,
      false,
      lookupAll,
      dispatcherFactory,
    );

    await service.createChatCompletion(connection, { messages: [] });

    expect(lookupAll).toHaveBeenCalledTimes(2);
    expect(dispatcherFactory).toHaveBeenNthCalledWith(1, [
      { address: '93.184.216.34', family: 4 },
    ]);
    expect(dispatcherFactory).toHaveBeenNthCalledWith(2, [
      { address: '93.184.216.35', family: 4 },
    ]);
    expect(fetchMock.mock.calls.map(([url]) => (url as URL).hostname))
      .toEqual(['provider.example', 'provider.example']);
    expect(dispatchers[0].close).toHaveBeenCalledOnce();
    expect(dispatchers[1].close).toHaveBeenCalledOnce();
  });

  it('pins the complete vetted address set and fails over without re-resolving', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const lookupAll = vi.fn().mockResolvedValue([
      { address: '127.0.0.2', family: 4 },
      { address: '127.0.0.1', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    const service = new AiProviderService('secret', undefined, true, lookupAll);

    try {
      await expect(service.createChatCompletion({
        ...connection,
        baseUrl: `http://provider.local:${port}/v1`,
      }, { messages: [] })).resolves.toMatchObject({
        choices: [{ message: { content: 'ok' } }],
      });
      expect(lookupAll).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) reject(error);
        else resolve();
      }));
    }
  });

  it('rejects cross-origin redirects before forwarding provider credentials', async () => {
    vi.mocked(db.select).mockReturnValue(selectRows([{
      ...providerRow,
      apiKeyEncrypted: null,
      apiKeyHint: null,
    }]) as never);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data' },
    }));
    const service = new AiProviderService('secret', fetchMock, false, publicLookup);

    await expect(service.listModels(providerRow.userId, providerRow.id))
      .rejects.toMatchObject({ code: 'PROCESSING_FAILED' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects provider responses larger than two MiB', async () => {
    vi.mocked(db.select).mockReturnValue(selectRows([{
      ...providerRow,
      apiKeyEncrypted: null,
      apiKeyHint: null,
    }]) as never);
    const fetchMock = vi.fn().mockResolvedValue(new Response('x'.repeat(2 * 1024 * 1024 + 1)));
    const service = new AiProviderService('secret', fetchMock, false, publicLookup);

    await expect(service.listModels(providerRow.userId, providerRow.id))
      .rejects.toMatchObject({ code: 'PROCESSING_FAILED' });
  });

  it('should honor a caller timeout longer than the provider default for chat completions', async () => {
    vi.useFakeTimers();
    try {
      let resolveFetch!: (response: Response) => void;
      const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }));
      const close = vi.fn().mockResolvedValue(undefined);
      const service = new AiProviderService(
        'secret',
        fetchMock,
        false,
        publicLookup,
        vi.fn().mockReturnValue({ close }),
      );

      const completion = service.createChatCompletion(
        connection,
        { messages: [] },
        45_000,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledOnce();
      const outboundSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;

      await vi.advanceTimersByTimeAsync(10_001);

      const abortedAfterDiscoveryDeadline = outboundSignal.aborted;
      resolveFetch(new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
      })));
      await expect(completion).resolves.toMatchObject({
        choices: [{ message: { content: 'ok' } }],
      });
      expect(close).toHaveBeenCalledOnce();
      expect(abortedAfterDiscoveryDeadline).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      label: 'shorter caller deadline',
      requestedTimeoutMs: 5_000,
      effectiveTimeoutMs: 5_000,
    },
    {
      label: 'forty-five-second maximum',
      requestedTimeoutMs: 60_000,
      effectiveTimeoutMs: 45_000,
    },
  ])('should abort chat completions at the $label', async ({
    requestedTimeoutMs,
    effectiveTimeoutMs,
  }) => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockImplementation(
        (_url: URL, init: RequestInit) => new Promise<Response>(
          (_resolve, reject) => init.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          ),
        ),
      );
      const close = vi.fn().mockResolvedValue(undefined);
      const service = new AiProviderService(
        'secret',
        fetchMock,
        false,
        publicLookup,
        vi.fn().mockReturnValue({ close }),
      );

      const completion = service.createChatCompletion(
        connection,
        { messages: [] },
        requestedTimeoutMs,
      );
      const rejection = expect(completion).rejects.toMatchObject({ code: 'PROCESSING_FAILED' });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledOnce();
      const outboundSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;

      await vi.advanceTimersByTimeAsync(effectiveTimeoutMs - 1);
      expect(outboundSignal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(outboundSignal.aborted).toBe(true);
      await rejection;
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should keep model discovery bounded by the ten-second provider default', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(db.select).mockReturnValue(selectRows([{
        ...providerRow,
        apiKeyEncrypted: null,
        apiKeyHint: null,
      }]) as never);
      const fetchMock = vi.fn().mockImplementation(
        (_url: URL, init: RequestInit) => new Promise<Response>(
          (_resolve, reject) => init.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          ),
        ),
      );
      const close = vi.fn().mockResolvedValue(undefined);
      const service = new AiProviderService(
        'secret',
        fetchMock,
        false,
        publicLookup,
        vi.fn().mockReturnValue({ close }),
      );

      const models = service.listModels(providerRow.userId, providerRow.id);
      const rejection = expect(models).rejects.toMatchObject({ code: 'PROCESSING_FAILED' });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledOnce();
      const outboundSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;

      await vi.advanceTimersByTimeAsync(9_999);
      expect(outboundSignal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(outboundSignal.aborted).toBe(true);
      await rejection;
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('combines client cancellation with its deadline and removes the parent listener', async () => {
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const fetchMock = vi.fn().mockImplementation(
      async (_url: URL, init: RequestInit) => new Promise(
        (_resolve, reject) => init.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason),
          { once: true },
        ),
      ),
    );
    const close = vi.fn().mockResolvedValue(undefined);
    const service = new AiProviderService(
      'secret',
      fetchMock,
      false,
      publicLookup,
      vi.fn().mockReturnValue({ close }),
    );

    const completion = service.createChatCompletion(
      connection,
      { messages: [] },
      10_000,
      controller.signal,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const outboundSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    expect(outboundSignal).not.toBe(controller.signal);
    controller.abort();

    await expect(completion).rejects.toMatchObject({ code: 'PROCESSING_FAILED' });
    expect(outboundSignal.aborted).toBe(true);
    expect(addListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(close).toHaveBeenCalledOnce();
  });
});
