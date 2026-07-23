import { afterEach, describe, expect, it, vi } from 'vitest';
import { postForLibrary, putRaw, setActiveLibraryId } from './client';

describe('upload API client cancellation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setActiveLibraryId(null);
  });

  it('should abort the active XHR when its signal is cancelled', async () => {
    vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(() => undefined);
    const abort = vi.spyOn(XMLHttpRequest.prototype, 'abort');
    const controller = new AbortController();

    const upload = putRaw('/models/upload/upload-1/chunk/0', new Blob(['chunk']), undefined, controller.signal);
    controller.abort();

    await expect(upload).rejects.toMatchObject({ name: 'AbortError' });
    expect(abort).toHaveBeenCalledOnce();
  });

  it('should prefer an explicit captured library over mutable active-library state', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { sessionId: 'session-a' }, meta: null, errors: null }),
    });
    vi.stubGlobal('fetch', fetchMock);
    setActiveLibraryId('library-b');

    await postForLibrary('/models/upload/upload-1/complete', undefined, 'library-a');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual(expect.objectContaining({ 'X-Library-Id': 'library-a' }));
    expect(init.signal).toBeUndefined();
  });
});
