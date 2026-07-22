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
}

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
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  nodeEnv: process.env.NODE_ENV || 'development',
};
