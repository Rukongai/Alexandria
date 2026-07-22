import { describe, expect, it, vi } from 'vitest';
import { WebSearchService } from './web-search.service.js';

describe('WebSearchService source normalization', () => {
  it('returns only http(s) URLs from DuckDuckGo', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      Heading: 'Safe result',
      AbstractURL: 'javascript:alert(1)',
      AbstractText: 'not safe to link',
      RelatedTopics: [
        { FirstURL: 'data:text/html,bad', Text: 'Bad result' },
        { FirstURL: 'https://example.com/result', Text: 'Good result - summary' },
      ],
    }), { status: 200 }));

    const result = await new WebSearchService(fetchMock).searchWeb('models');
    expect(result.sources).toEqual([expect.objectContaining({ url: 'https://example.com/result' })]);
    expect(result.sources.every((source) => /^https?:/.test(source.url))).toBe(true);
  });

  it('filters unsafe page and image URLs from Wikimedia Commons', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      query: {
        pages: {
          safe: {
            title: 'File:Safe.jpg',
            fullurl: 'https://commons.wikimedia.org/wiki/File:Safe.jpg',
            imageinfo: [{ thumburl: 'https://upload.wikimedia.org/safe.jpg' }],
          },
          unsafe: {
            title: 'File:Unsafe.svg',
            fullurl: 'https://commons.wikimedia.org/wiki/File:Unsafe.svg',
            imageinfo: [{ thumburl: 'data:image/svg+xml,bad' }],
          },
        },
      },
    }), { status: 200 }));

    const result = await new WebSearchService(fetchMock).searchImages('dragon');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      url: 'https://commons.wikimedia.org/wiki/File:Safe.jpg',
      imageUrl: 'https://upload.wikimedia.org/safe.jpg',
    });
  });

  it('turns upstream failure into an empty tool-level result', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network unavailable'));
    const result = await new WebSearchService(fetchMock).searchWeb('dragon');
    expect(result.sources).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  it('rejects public search responses larger than one MiB', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('x'.repeat(1024 * 1024 + 1)),
    );
    const result = await new WebSearchService(fetchMock).searchWeb('dragon');
    expect(result.sources).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  it('cancels an upstream search on client disconnect and removes the parent listener', async () => {
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
    const service = new WebSearchService(fetchMock);

    const search = service.searchWeb('dragon', 7_000, controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();

    await expect(search).rejects.toMatchObject({ code: 'PROCESSING_FAILED' });
    expect(addListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
