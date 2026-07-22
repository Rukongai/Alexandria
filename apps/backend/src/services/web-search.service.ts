import type { AiSource } from '@alexandria/shared';
import { createLogger } from '../utils/logger.js';
import { readBoundedResponseText } from '../utils/http-response.js';
import { createTimeoutAbortSignal } from '../utils/abort-signal.js';
import { processingError } from '../utils/errors.js';

const logger = createLogger('WebSearchService');
const SEARCH_TIMEOUT_MS = 7_000;
const MAX_RESULTS = 8;
const MAX_SEARCH_RESPONSE_BYTES = 1024 * 1024;

export interface WebSearchResult {
  sources: AiSource[];
  error?: string;
}

function cleanText(value: unknown, maxLength = 1_000): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function flattenRelatedTopics(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (item && typeof item === 'object' && Array.isArray((item as { Topics?: unknown }).Topics)) {
      return flattenRelatedTopics((item as { Topics: unknown }).Topics);
    }
    return [item];
  });
}

export class WebSearchService {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async searchWeb(
    query: string,
    timeoutMs = SEARCH_TIMEOUT_MS,
    requestSignal?: AbortSignal,
  ): Promise<WebSearchResult> {
    const requestAbort = createTimeoutAbortSignal(
      Math.max(1, Math.min(timeoutMs, SEARCH_TIMEOUT_MS)),
      requestSignal,
    );
    try {
      const url = new URL('https://api.duckduckgo.com/');
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('no_html', '1');
      url.searchParams.set('skip_disambig', '1');
      const response = await this.fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: requestAbort.signal,
      });
      if (!response.ok) throw new Error(`DuckDuckGo returned ${response.status}`);
      const body = JSON.parse(
        await readBoundedResponseText(response, MAX_SEARCH_RESPONSE_BYTES),
      ) as Record<string, unknown>;
      const sources: AiSource[] = [];
      const abstractUrl = safeHttpUrl(body.AbstractURL);
      if (abstractUrl) {
        sources.push({
          title: cleanText(body.Heading, 300) ?? query.slice(0, 300),
          url: abstractUrl,
          ...(cleanText(body.AbstractText) ? { snippet: cleanText(body.AbstractText) } : {}),
        });
      }
      for (const item of flattenRelatedTopics(body.RelatedTopics)) {
        if (!item || typeof item !== 'object') continue;
        const topic = item as Record<string, unknown>;
        const topicUrl = safeHttpUrl(topic.FirstURL);
        if (!topicUrl) continue;
        const text = cleanText(topic.Text);
        sources.push({
          title: text?.split(' - ')[0]?.slice(0, 300) ?? query.slice(0, 300),
          url: topicUrl,
          ...(text ? { snippet: text } : {}),
        });
        if (sources.length >= MAX_RESULTS) break;
      }
      return { sources: this.uniqueSources(sources) };
    } catch (error) {
      if (requestSignal?.aborted) {
        throw processingError('AI assistant request was cancelled');
      }
      logger.warn({ service: 'WebSearchService', err: error, query }, 'Public web search failed');
      return { sources: [], error: 'Web search is temporarily unavailable' };
    } finally {
      requestAbort.cleanup();
    }
  }

  async searchImages(
    query: string,
    timeoutMs = SEARCH_TIMEOUT_MS,
    requestSignal?: AbortSignal,
  ): Promise<WebSearchResult> {
    const requestAbort = createTimeoutAbortSignal(
      Math.max(1, Math.min(timeoutMs, SEARCH_TIMEOUT_MS)),
      requestSignal,
    );
    try {
      const url = new URL('https://commons.wikimedia.org/w/api.php');
      url.searchParams.set('action', 'query');
      url.searchParams.set('format', 'json');
      url.searchParams.set('origin', '*');
      url.searchParams.set('generator', 'search');
      url.searchParams.set('gsrsearch', query);
      url.searchParams.set('gsrnamespace', '6');
      url.searchParams.set('gsrlimit', String(MAX_RESULTS));
      url.searchParams.set('prop', 'imageinfo|info');
      url.searchParams.set('inprop', 'url');
      url.searchParams.set('iiprop', 'url|extmetadata');
      url.searchParams.set('iiurlwidth', '500');
      const response = await this.fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: requestAbort.signal,
      });
      if (!response.ok) throw new Error(`Wikimedia Commons returned ${response.status}`);
      const body = JSON.parse(
        await readBoundedResponseText(response, MAX_SEARCH_RESPONSE_BYTES),
      ) as {
        query?: { pages?: Record<string, Record<string, unknown>> };
      };
      const pages = Object.values(body.query?.pages ?? {});
      const sources = pages.flatMap((page): AiSource[] => {
        const info = Array.isArray(page.imageinfo) ? page.imageinfo[0] as Record<string, unknown> : null;
        const imageUrl = safeHttpUrl(info && (typeof info.thumburl === 'string' ? info.thumburl : info.url));
        const pageUrl = safeHttpUrl(page.fullurl);
        if (!imageUrl || !pageUrl) return [];
        const metadata = info?.extmetadata as Record<string, { value?: unknown }> | undefined;
        const description = cleanText(metadata?.ImageDescription?.value);
        return [{
          title: cleanText(page.title, 300)?.replace(/^File:/, '') ?? query.slice(0, 300),
          url: pageUrl,
          imageUrl,
          ...(description ? { snippet: description } : {}),
        }];
      });
      return { sources: this.uniqueSources(sources) };
    } catch (error) {
      if (requestSignal?.aborted) {
        throw processingError('AI assistant request was cancelled');
      }
      logger.warn({ service: 'WebSearchService', err: error, query }, 'Public image search failed');
      return { sources: [], error: 'Image search is temporarily unavailable' };
    } finally {
      requestAbort.cleanup();
    }
  }

  private uniqueSources(sources: AiSource[]): AiSource[] {
    const seen = new Set<string>();
    return sources.filter((source) => {
      if (seen.has(source.url)) return false;
      seen.add(source.url);
      return true;
    }).slice(0, MAX_RESULTS);
  }
}

export const webSearchService = new WebSearchService();
