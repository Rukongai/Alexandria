import { config } from '../config/index.js';
import { migrateLocalStorage } from '../services/storage-migration.service.js';
import {
  createStorageService,
  LocalStorageService,
  validateStorageBackend,
} from '../services/storage.service.js';

async function main(): Promise<void> {
  if (config.storageBackend !== 's3') {
    throw new Error('Set STORAGE_BACKEND=s3 and the S3_* variables before running this command');
  }

  const source = new LocalStorageService(config.storagePath);
  const target = createStorageService(config);
  await validateStorageBackend(target);

  console.log(`Migrating local storage from ${source.getStorageRoot()} to S3...`);
  const result = await migrateLocalStorage(source, target, ({ current, total, key, status }) => {
    console.log(`[${current}/${total}] ${status}: ${key}`);
  });

  console.log(
    `Storage migration complete: ${result.copied} copied, ${result.skipped} already verified, ${result.total} total.`,
  );
  console.log('Local source files were retained for rollback.');
}

main().catch((error) => {
  console.error('Storage migration failed:', error);
  process.exit(1);
});
