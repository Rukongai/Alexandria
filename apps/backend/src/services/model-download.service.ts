import archiver from 'archiver';
import { once } from 'node:events';
import type { ModelFile } from '../db/schema/model-file.js';
import { storageService, type IStorageService } from './storage.service.js';

type DownloadableModelFile = Pick<ModelFile, 'relativePath' | 'storagePath'>;

export function createModelArchive(
  files: DownloadableModelFile[],
  storage: IStorageService = storageService,
) {
  const archive = archiver('zip', { zlib: { level: 6 } });

  void (async () => {
    try {
      // Wait for each entry to finish before opening the next remote stream. This
      // keeps large model downloads from holding one S3 connection per file.
      for (const file of files) {
        const source = await storage.retrieveStream(file.storagePath);
        const entryComplete = once(archive, 'entry');
        archive.append(source, { name: file.relativePath });
        await entryComplete;
      }
      await archive.finalize();
    } catch (error) {
      archive.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  })();

  return archive;
}
