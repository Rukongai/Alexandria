import crypto from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type {
  AiProvider,
  AiProviderModel,
  AiProviderTestResult,
  CreateAiProviderRequest,
  UpdateAiProviderRequest,
} from '@alexandria/shared';
import { db } from '../db/index.js';
import { aiProviders } from '../db/schema/index.js';
import type { AiProvider as AiProviderRow } from '../db/schema/ai-provider.js';
import { config } from '../config/index.js';
import { AppError, internalError, notFound, processingError, validationError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { readBoundedResponseText } from '../utils/http-response.js';
import { createTimeoutAbortSignal } from '../utils/abort-signal.js';

const logger = createLogger('AiProviderService');
const PROVIDER_DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_CHAT_COMPLETION_TIMEOUT_MS = 45_000;
const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const CIPHER_VERSION = 'v1';

type LookupResult = { address: string; family: number };
type VettedTarget = { address: string; family: 4 | 6 };
type LookupAll = (hostname: string) => Promise<LookupResult[]>;
type ProviderFetchInit = RequestInit & { dispatcher?: Dispatcher };
type ProviderFetch = (input: URL, init: ProviderFetchInit) => Promise<Response>;
type DispatcherFactory = (addresses: VettedTarget[]) => Dispatcher;

const defaultProviderFetch = undiciFetch as unknown as ProviderFetch;

const ALWAYS_BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.google',
  'metadata.azure.internal',
]);

export interface AiProviderConnection {
  id: string;
  baseUrl: string;
  model: string;
  apiKey: string | null;
}

function encryptionKey(secret: string): Buffer {
  if (!secret) {
    throw internalError('AI_ENCRYPTION_KEY is required in production');
  }
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

export function normalizeAiBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw validationError('Base URL must use http or https', 'baseUrl');
  }
  if (url.username || url.password) {
    throw validationError('Base URL must not contain embedded credentials', 'baseUrl');
  }
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export function encryptAiSecret(plaintext: string, secret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [CIPHER_VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decryptAiSecret(payload: string, secret: string): string {
  try {
    const [version, iv, tag, ciphertext] = payload.split(':');
    if (version !== CIPHER_VERSION || !iv || !tag || ciphertext === undefined) {
      throw new Error('Invalid encrypted value');
    }
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      encryptionKey(secret),
      Buffer.from(iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    logger.error({ service: 'AiProviderService', err: error }, 'Failed to decrypt provider API key');
    throw internalError('Unable to decrypt AI provider credentials');
  }
}

function apiKeyHint(apiKey: string): string {
  // Do not reveal a short key in full. Hints are identification-only.
  return apiKey.length > 4 ? `••••${apiKey.slice(-4)}` : '••••';
}

function toPublicProvider(row: AiProviderRow): AiProvider {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    model: row.model,
    isDefault: row.isDefault,
    hasApiKey: row.apiKeyEncrypted !== null,
    apiKeyHint: row.apiKeyHint,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await readBoundedResponseText(response, MAX_PROVIDER_RESPONSE_BYTES);
  if (!response.ok) {
    throw processingError(`AI provider request failed with status ${response.status}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw processingError('AI provider returned invalid JSON');
  }
}

export class AiProviderService {
  constructor(
    private readonly secret = config.aiEncryptionKey,
    private readonly fetchImpl: ProviderFetch = defaultProviderFetch,
    private readonly allowPrivateUrls = config.aiAllowPrivateProviderUrls,
    private readonly lookupAll: LookupAll = async (hostname) => lookup(hostname, {
      all: true,
      verbatim: true,
    }),
    private readonly dispatcherFactory: DispatcherFactory = createPinnedDispatcher,
  ) {}

  async list(userId: string): Promise<AiProvider[]> {
    const rows = await db
      .select()
      .from(aiProviders)
      .where(eq(aiProviders.userId, userId))
      .orderBy(asc(aiProviders.createdAt));
    return rows.map(toPublicProvider);
  }

  async create(userId: string, data: CreateAiProviderRequest): Promise<AiProvider> {
    const key = data.apiKey ? data.apiKey : null;
    const baseUrl = normalizeAiBaseUrl(data.baseUrl);
    await assertSafeProviderUrl(baseUrl, this.allowPrivateUrls, this.lookupAll);
    const row = await db.transaction(async (tx) => {
      await this.lockUserProviderDefaults(tx, userId);
      const [currentDefault] = await tx
        .select({ id: aiProviders.id })
        .from(aiProviders)
        .where(and(eq(aiProviders.userId, userId), eq(aiProviders.isDefault, true)))
        .limit(1);
      const makeDefault = data.isDefault === true || !currentDefault;
      if (makeDefault && currentDefault) {
        await tx
          .update(aiProviders)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(eq(aiProviders.id, currentDefault.id));
      }
      const [created] = await tx
        .insert(aiProviders)
        .values({
          userId,
          name: data.name,
          baseUrl,
          model: data.model,
          apiKeyEncrypted: key ? encryptAiSecret(key, this.secret) : null,
          apiKeyHint: key ? apiKeyHint(key) : null,
          isDefault: makeDefault,
        })
        .returning();
      return created;
    });
    logger.info({ service: 'AiProviderService', providerId: row.id, userId }, 'AI provider created');
    return toPublicProvider(row);
  }

  async update(userId: string, id: string, data: UpdateAiProviderRequest): Promise<AiProvider> {
    const key = data.apiKey === undefined ? undefined : data.apiKey || null;
    const baseUrl = data.baseUrl === undefined ? undefined : normalizeAiBaseUrl(data.baseUrl);
    if (baseUrl) await assertSafeProviderUrl(baseUrl, this.allowPrivateUrls, this.lookupAll);

    const updated = await db.transaction(async (tx) => {
      await this.lockUserProviderDefaults(tx, userId);
      const [existing] = await tx
        .select()
        .from(aiProviders)
        .where(and(eq(aiProviders.id, id), eq(aiProviders.userId, userId)))
        .limit(1);
      if (!existing) throw notFound('AI provider not found');

      if (data.isDefault === true && !existing.isDefault) {
        await tx
          .update(aiProviders)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(and(eq(aiProviders.userId, userId), eq(aiProviders.isDefault, true)));
      }

      const values: Partial<typeof aiProviders.$inferInsert> = { updatedAt: new Date() };
      if (data.name !== undefined) values.name = data.name;
      if (baseUrl !== undefined) values.baseUrl = baseUrl;
      if (data.model !== undefined) values.model = data.model;
      if (key !== undefined) {
        values.apiKeyEncrypted = key ? encryptAiSecret(key, this.secret) : null;
        values.apiKeyHint = key ? apiKeyHint(key) : null;
      }

      // A user must retain a deterministic default whenever providers exist.
      // Clear the current row before promoting a replacement to satisfy the
      // partial unique index throughout the transaction.
      if (data.isDefault === false && existing.isDefault) {
        values.isDefault = false;
        const [row] = await tx
          .update(aiProviders)
          .set(values)
          .where(and(eq(aiProviders.id, id), eq(aiProviders.userId, userId)))
          .returning();
        const [replacement] = await tx
          .select({ id: aiProviders.id })
          .from(aiProviders)
          .where(and(eq(aiProviders.userId, userId), ne(aiProviders.id, id)))
          .orderBy(asc(aiProviders.createdAt))
          .limit(1);
        if (replacement) {
          await tx.update(aiProviders).set({ isDefault: true, updatedAt: new Date() }).where(eq(aiProviders.id, replacement.id));
        } else {
          const [restored] = await tx
            .update(aiProviders)
            .set({ isDefault: true, updatedAt: new Date() })
            .where(eq(aiProviders.id, id))
            .returning();
          return restored;
        }
        return row;
      }

      if (data.isDefault !== undefined) values.isDefault = data.isDefault;
      const [row] = await tx
        .update(aiProviders)
        .set(values)
        .where(and(eq(aiProviders.id, id), eq(aiProviders.userId, userId)))
        .returning();
      return row;
    });

    logger.info({ service: 'AiProviderService', providerId: id, userId }, 'AI provider updated');
    return toPublicProvider(updated);
  }

  async delete(userId: string, id: string): Promise<void> {
    await db.transaction(async (tx) => {
      await this.lockUserProviderDefaults(tx, userId);
      const [existing] = await tx
        .select()
        .from(aiProviders)
        .where(and(eq(aiProviders.id, id), eq(aiProviders.userId, userId)))
        .limit(1);
      if (!existing) throw notFound('AI provider not found');
      await tx.delete(aiProviders).where(eq(aiProviders.id, id));
      if (existing.isDefault) {
        const [replacement] = await tx
          .select({ id: aiProviders.id })
          .from(aiProviders)
          .where(eq(aiProviders.userId, userId))
          .orderBy(asc(aiProviders.createdAt))
          .limit(1);
        if (replacement) {
          await tx.update(aiProviders).set({ isDefault: true, updatedAt: new Date() }).where(eq(aiProviders.id, replacement.id));
        }
      }
    });
    logger.info({ service: 'AiProviderService', providerId: id, userId }, 'AI provider deleted');
  }

  async listModels(userId: string, id: string): Promise<AiProviderModel[]> {
    const connection = await this.resolveConnection(userId, id);
    const body = await this.providerRequest(connection, '/models', { method: 'GET' });
    if (!body || typeof body !== 'object' || !Array.isArray((body as { data?: unknown }).data)) {
      throw processingError('AI provider returned an invalid models response');
    }
    return (body as { data: unknown[] }).data
      .flatMap((item) => {
        if (!item || typeof item !== 'object' || typeof (item as { id?: unknown }).id !== 'string') return [];
        const ownedBy = typeof (item as { owned_by?: unknown }).owned_by === 'string'
          ? (item as { owned_by: string }).owned_by
          : null;
        return [{ id: (item as { id: string }).id, ownedBy }];
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async test(userId: string, id: string): Promise<AiProviderTestResult> {
    const models = await this.listModels(userId, id);
    return { ok: true, modelCount: models.length };
  }

  async resolveConnection(userId: string, providerId?: string): Promise<AiProviderConnection> {
    const where = providerId
      ? and(eq(aiProviders.id, providerId), eq(aiProviders.userId, userId))
      : and(eq(aiProviders.userId, userId), eq(aiProviders.isDefault, true));
    const [row] = await db.select().from(aiProviders).where(where).limit(1);
    if (!row) throw notFound(providerId ? 'AI provider not found' : 'Default AI provider not found');
    return {
      id: row.id,
      baseUrl: row.baseUrl,
      model: row.model,
      apiKey: row.apiKeyEncrypted ? decryptAiSecret(row.apiKeyEncrypted, this.secret) : null,
    };
  }

  async createChatCompletion(
    connection: AiProviderConnection,
    payload: unknown,
    timeoutMs = MAX_CHAT_COMPLETION_TIMEOUT_MS,
    requestSignal?: AbortSignal,
  ): Promise<unknown> {
    const boundedTimeoutMs = Math.max(1, Math.min(timeoutMs, MAX_CHAT_COMPLETION_TIMEOUT_MS));
    return this.providerRequest(connection, '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }, boundedTimeoutMs, requestSignal);
  }

  private async providerRequest(
    connection: AiProviderConnection,
    path: string,
    init: RequestInit,
    timeoutMs = PROVIDER_DISCOVERY_TIMEOUT_MS,
    requestSignal?: AbortSignal,
  ): Promise<unknown> {
    const headers = new Headers(init.headers);
    if (connection.apiKey) headers.set('authorization', `Bearer ${connection.apiKey}`);
    const requestAbort = createTimeoutAbortSignal(Math.max(1, timeoutMs), requestSignal);
    try {
      const initialUrl = new URL(`${connection.baseUrl}${path}`);
      let targetUrl = initialUrl;
      for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
        const vettedTargets = await withAbortSignal(
          resolveSafeProviderTargets(targetUrl, this.allowPrivateUrls, this.lookupAll),
          requestAbort.signal,
        );
        const dispatcher = this.dispatcherFactory(vettedTargets);
        try {
          // The URL remains unchanged so HTTP Host and TLS SNI use the configured
          // hostname; only socket resolution is replaced by the vetted address.
          const response = await this.fetchImpl(targetUrl, {
            ...init,
            headers,
            redirect: 'manual',
            signal: requestAbort.signal,
            dispatcher,
          });
          if (!isRedirect(response.status)) return await readJsonResponse(response);

          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location || redirectCount === MAX_REDIRECTS) {
            throw processingError('AI provider returned too many or invalid redirects');
          }
          const nextUrl = new URL(location, targetUrl);
          if (nextUrl.origin !== initialUrl.origin) {
            throw processingError('AI provider redirected to a different origin');
          }
          targetUrl = nextUrl;
        } finally {
          await dispatcher.close();
        }
      }
      throw processingError('AI provider returned too many redirects');
    } catch (error) {
      if (error instanceof AppError) throw error;
      logger.warn(
        { service: 'AiProviderService', providerId: connection.id, err: error },
        'AI provider request failed',
      );
      throw processingError('AI provider request failed or timed out');
    } finally {
      requestAbort.cleanup();
    }
  }

  private async lockUserProviderDefaults(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    userId: string,
  ): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export async function assertSafeProviderUrl(
  value: string | URL,
  allowPrivate: boolean,
  lookupAll: LookupAll = async (hostname) => lookup(hostname, { all: true, verbatim: true }),
): Promise<void> {
  await resolveSafeProviderTargets(value, allowPrivate, lookupAll);
}

async function resolveSafeProviderTargets(
  value: string | URL,
  allowPrivate: boolean,
  lookupAll: LookupAll,
): Promise<VettedTarget[]> {
  const url = value instanceof URL ? value : new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (ALWAYS_BLOCKED_HOSTNAMES.has(hostname)) {
    throw validationError('AI provider URL targets a blocked metadata host', 'baseUrl');
  }

  let addresses: LookupResult[];
  if (ipaddr.isValid(hostname)) {
    addresses = [{
      address: hostname,
      family: ipaddr.parse(hostname).kind() === 'ipv4' ? 4 : 6,
    }];
  } else {
    try {
      addresses = await withTimeout(lookupAll(hostname), 3_000);
    } catch {
      throw validationError('AI provider hostname could not be resolved', 'baseUrl');
    }
  }
  if (addresses.length === 0) {
    throw validationError('AI provider hostname could not be resolved', 'baseUrl');
  }

  let allAddressesPrivate = true;
  const normalizedAddresses: VettedTarget[] = [];
  const seenAddresses = new Set<string>();
  for (const { address } of addresses) {
    const classification = classifyAddress(address);
    if (classification === 'blocked') {
      throw validationError('AI provider URL targets a blocked network address', 'baseUrl');
    }
    if (classification === 'private' && !allowPrivate) {
      throw validationError('Private AI provider URLs are not enabled', 'baseUrl');
    }
    if (classification !== 'private') allAddressesPrivate = false;
    const normalizedAddress = address.split('%')[0];
    const family = ipaddr.parse(normalizedAddress).kind() === 'ipv4' ? 4 : 6;
    const key = `${family}:${normalizedAddress}`;
    if (!seenAddresses.has(key)) {
      seenAddresses.add(key);
      normalizedAddresses.push({ address: normalizedAddress, family });
    }
  }
  if (url.protocol === 'http:' && !allAddressesPrivate) {
    throw validationError('Public AI provider URLs must use https', 'baseUrl');
  }
  return normalizedAddresses;
}

function createPinnedDispatcher(addresses: VettedTarget[]): Dispatcher {
  return new Agent({
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 250,
    connect: {
      lookup: (_hostname, options, callback) => {
        if (options.all) {
          callback(null, addresses);
          return;
        }
        const [first] = addresses;
        callback(null, first.address, first.family);
      },
    },
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('DNS lookup timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function withAbortSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function classifyAddress(rawAddress: string): 'public' | 'private' | 'blocked' {
  const address = rawAddress.toLowerCase().split('%')[0];
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return 'blocked';
  }

  if (parsed.kind() === 'ipv4') {
    const ipv4 = parsed as ipaddr.IPv4;
    const [a, b] = ipv4.octets;
    if (a === 169 && b === 254) return 'blocked';
    if (ipv4.toString() === '100.100.100.200') return 'blocked';
    const range = ipv4.range();
    if (range === 'private' || range === 'loopback') return 'private';
    return range === 'unicast' ? 'public' : 'blocked';
  }

  const ipv6 = parsed as ipaddr.IPv6;
  if (ipv6.isIPv4MappedAddress()) {
    return classifyAddress(ipv6.toIPv4Address().toString());
  }
  if (
    ipv6.match(ipaddr.IPv6.parse('64:ff9b::'), 96)
    || ipv6.match(ipaddr.IPv6.parse('64:ff9b:1::'), 48)
    || ipv6.match(ipaddr.IPv6.parse('2002::'), 16)
    || ipv6.match(ipaddr.IPv6.parse('2001::'), 32)
  ) {
    return 'blocked';
  }
  const normalized = ipv6.toRFC5952String();
  if (normalized === 'fd00:ec2::254' || normalized === 'fd20:ce::254') return 'blocked';
  const range = ipv6.range();
  if (range === 'loopback' || range === 'uniqueLocal') return 'private';
  if (range !== 'unicast') return 'blocked';

  const bytes = ipv6.toByteArray();
  const isIpv4Compatible = bytes.slice(0, 12).every((byte) => byte === 0);
  const isIsatap = (
    (bytes[8] === 0 || bytes[8] === 2)
    && bytes[9] === 0
    && bytes[10] === 0x5e
    && bytes[11] === 0xfe
  );
  return isIpv4Compatible || isIsatap ? 'blocked' : 'public';
}

export const aiProviderService = new AiProviderService();
