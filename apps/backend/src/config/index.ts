const nodeEnv = process.env.NODE_ENV || 'development';
const sessionSecret = process.env.SESSION_SECRET || 'dev-secret-change-in-production';

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

export const config = {
  port: parseInt(process.env.PORT || '3000'),
  host: process.env.HOST || '0.0.0.0',
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgresql://alexandria:alexandria@localhost:5432/alexandria',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  storagePath: process.env.STORAGE_PATH || './data/storage',
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
