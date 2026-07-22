import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendAiChat } from './ai';

describe('AI API client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should forward an abort signal to the chat request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        data: { message: 'Done', sources: [], proposal: null },
        meta: null,
        errors: null,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await sendAiChat({ message: 'Hello' }, controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ai/chat',
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
