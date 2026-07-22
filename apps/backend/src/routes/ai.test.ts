import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { EventEmitter } from 'node:events';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(async (request: { user?: unknown }) => {
    request.user = { id: '11111111-1111-4111-8111-111111111111' };
  }),
  requireLibrary: vi.fn(async (request: { libraryId?: string }) => {
    request.libraryId = '22222222-2222-4222-8222-222222222222';
  }),
  chat: vi.fn(),
  apply: vi.fn(),
  listProviders: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('../middleware/library.js', () => ({ requireLibrary: mocks.requireLibrary }));
vi.mock('../services/ai-assistant.service.js', () => ({
  aiAssistantService: { chat: mocks.chat },
}));
vi.mock('../services/ai-proposal.service.js', () => ({
  aiProposalService: { apply: mocks.apply },
}));
vi.mock('../services/ai-provider.service.js', () => ({
  aiProviderService: {
    list: mocks.listProviders,
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    test: vi.fn(),
    listModels: vi.fn(),
  },
}));

import { aiRoutes, monitorClientDisconnect } from './ai.js';

describe('AI chat disconnect monitoring', () => {
  it('aborts on a premature response close and removes both listeners', () => {
    const requestRaw = Object.assign(new EventEmitter(), { aborted: false });
    const replyRaw = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
    });
    const monitored = monitorClientDisconnect(
      { raw: requestRaw } as never,
      { raw: replyRaw } as never,
    );

    expect(requestRaw.listenerCount('aborted')).toBe(1);
    expect(replyRaw.listenerCount('close')).toBe(1);
    replyRaw.emit('close');
    expect(monitored.signal.aborted).toBe(true);

    monitored.cleanup();
    expect(requestRaw.listenerCount('aborted')).toBe(0);
    expect(replyRaw.listenerCount('close')).toBe(0);
  });

  it('does not abort when normal cleanup occurs before the response closes', () => {
    const requestRaw = Object.assign(new EventEmitter(), { aborted: false });
    const replyRaw = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
    });
    const monitored = monitorClientDisconnect(
      { raw: requestRaw } as never,
      { raw: replyRaw } as never,
    );

    monitored.cleanup();
    replyRaw.emit('close');
    expect(monitored.signal.aborted).toBe(false);
  });
});

describe('AI route middleware contract', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.chat.mockResolvedValue({ message: 'Done', sources: [], proposal: null });
    mocks.apply.mockResolvedValue({
      proposalId: '33333333-3333-4333-8333-333333333333',
      status: 'applied',
      changedModelIds: [],
    });
    mocks.listProviders.mockResolvedValue([]);
    app = Fastify();
    await app.register(aiRoutes, { prefix: '/ai' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('should require authentication and active library scope before chat', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ai/chat',
      payload: { message: 'Find my dragons' },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.requireAuth).toHaveBeenCalledTimes(1);
    expect(mocks.requireLibrary).toHaveBeenCalledTimes(1);
    expect(mocks.requireAuth.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.requireLibrary.mock.invocationCallOrder[0]);
    expect(mocks.chat).toHaveBeenCalledWith(
      { message: 'Find my dragons' },
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      expect.any(AbortSignal),
    );
    expect(response.json()).toEqual({
      data: { message: 'Done', sources: [], proposal: null },
      meta: null,
      errors: null,
    });
  });

  it('should require authentication and active library scope before proposal apply', async () => {
    const proposalId = '33333333-3333-4333-8333-333333333333';
    const response = await app.inject({
      method: 'POST',
      url: `/ai/proposals/${proposalId}/apply`,
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.requireAuth).toHaveBeenCalledTimes(1);
    expect(mocks.requireLibrary).toHaveBeenCalledTimes(1);
    expect(mocks.apply).toHaveBeenCalledWith(
      proposalId,
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    );
  });

  it('should keep provider configuration user-scoped rather than library-scoped', async () => {
    const response = await app.inject({ method: 'GET', url: '/ai/providers' });

    expect(response.statusCode).toBe(200);
    expect(mocks.requireAuth).toHaveBeenCalledTimes(1);
    expect(mocks.requireLibrary).not.toHaveBeenCalled();
    expect(mocks.listProviders).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
    );
  });
});
