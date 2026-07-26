import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBlob, postForLibrary, putRaw, setActiveLibraryId } from './client';

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

  it('sends the active library header when downloading a binary response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['mesh']),
    });
    vi.stubGlobal('fetch', fetchMock);
    setActiveLibraryId('library-b');

    await getBlob('/models/model-1/files/file-1/archive/download?path=body.stl');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual(expect.objectContaining({ 'X-Library-Id': 'library-b' }));
    expect(init.credentials).toBe('include');
  });
});
