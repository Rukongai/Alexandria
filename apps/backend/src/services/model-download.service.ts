import archiver from 'archiver';
import type { ModelFile } from '../db/schema/model-file.js';
import { storageService, type IStorageService } from './storage.service.js';

type DownloadableModelFile = Pick<ModelFile, 'relativePath' | 'storagePath'>;

export function createModelArchive(
  files: DownloadableModelFile[],
  storage: IStorageService = storageService,
) {
  const archive = archiver('zip', { zlib: { level: 6 } });

  for (const file of files) {
    archive.append(storage.retrieveStream(file.storagePath), {
      name: file.relativePath,
    });
  }

  return archive;
}
