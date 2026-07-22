export type StorageBackend = 'local' | 's3';

export interface AppConfig {
  port: number;
  host: string;
  databaseUrl: string;
  redisUrl: string;
  storageBackend: StorageBackend;
  storagePath: string;
  s3: {
    endpoint?: string;
    region: string;
    bucket?: string;
    prefix: string;
    forcePathStyle: boolean;
  };
  sessionSecret: string;
  nodeEnv: string;
  aiEncryptionKey: string;
  aiAllowPrivateProviderUrls: boolean;
}

const nodeEnv = process.env.NODE_ENV || 'development';
const sessionSecret = process.env.SESSION_SECRET || 'dev-secret-change-in-production';

function parseStorageBackend(value: string | undefined): StorageBackend {
  const backend = value || 'local';
  if (backend !== 'local' && backend !== 's3') {
    throw new Error('STORAGE_BACKEND must be either "local" or "s3"');
  }
  return backend;
}

function parseBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be either "true" or "false"`);
}

export function resolveAiEncryptionKey(
  environment: string,
  configuredKey: string | undefined,
  fallbackSecret: string,
): string {
  if (configuredKey) {
    if (environment === 'production' && configuredKey === fallbackSecret) {
      throw new Error('AI_ENCRYPTION_KEY must be separate from SESSION_SECRET in production');
    }
    if (
      environment === 'production'
      && ['change-me-to-a-separate-long-random-secret', 'change-me-in-production'].includes(configuredKey)
    ) {
      throw new Error('AI_ENCRYPTION_KEY must not use a known placeholder in production');
    }
    if (environment === 'production' && configuredKey.length < 32) {
      throw new Error('AI_ENCRYPTION_KEY must be at least 32 characters in production');
    }
    return configuredKey;
  }
  if (environment === 'production') {
    throw new Error('AI_ENCRYPTION_KEY is required in production');
  }
  return fallbackSecret;
}

export function resolveAllowPrivateProviderUrls(
  environment: string,
  configuredValue: string | undefined,
): boolean {
  if (configuredValue !== undefined) return configuredValue === 'true';
  return environment !== 'production';
}

export const config: AppConfig = {
  port: parseInt(process.env.PORT || '3000'),
  host: process.env.HOST || '0.0.0.0',
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgresql://alexandria:alexandria@localhost:5432/alexandria',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  storageBackend: parseStorageBackend(process.env.STORAGE_BACKEND),
  storagePath: process.env.STORAGE_PATH || './data/storage',
  s3: {
    endpoint: process.env.S3_ENDPOINT || undefined,
    region: process.env.S3_REGION || 'us-east-1',
    bucket: process.env.S3_BUCKET || undefined,
    prefix: process.env.S3_PREFIX || '',
    forcePathStyle: parseBoolean(process.env.S3_FORCE_PATH_STYLE, 'S3_FORCE_PATH_STYLE'),
  },
  sessionSecret,
  nodeEnv,
  // Production deliberately has no secret fallback: operators must provide a
  // separate encryption key for persisted AI-provider credentials.
  aiEncryptionKey: resolveAiEncryptionKey(nodeEnv, process.env.AI_ENCRYPTION_KEY, sessionSecret),
  aiAllowPrivateProviderUrls: resolveAllowPrivateProviderUrls(
    nodeEnv,
    process.env.AI_ALLOW_PRIVATE_PROVIDER_URLS,
  ),
};
