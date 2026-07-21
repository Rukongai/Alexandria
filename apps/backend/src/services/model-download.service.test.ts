import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { describe, expect, it, vi } from 'vitest';
import yauzl from 'yauzl';
import { createModelArchive } from './model-download.service.js';
import type { IStorageService } from './storage.service.js';

function readZipEntries(data: Buffer): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(data, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error('Failed to open ZIP'));
        return;
      }

      const entries = new Map<string, string>();
      zipFile.on('error', reject);
      zipFile.on('end', () => resolve(entries));
      zipFile.on('entry', (entry) => {
        zipFile.openReadStream(entry, async (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error(`Failed to read ${entry.fileName}`));
            return;
          }
          entries.set(entry.fileName, (await buffer(stream)).toString());
          zipFile.readEntry();
        });
      });
      zipFile.readEntry();
    });
  });
}

describe('createModelArchive', () => {
  it('streams stored files into a ZIP while preserving relative paths', async () => {
    const contents = new Map([
      ['models/m1/parts/body.stl', 'solid body'],
      ['models/m1/readme.txt', 'Print slowly'],
    ]);
    const retrieveStream = vi.fn((storagePath: string) =>
      Readable.from(contents.get(storagePath) ?? ''),
    );
    const storage = { retrieveStream } as unknown as IStorageService;
    const archive = createModelArchive(
      [
        { relativePath: 'parts/body.stl', storagePath: 'models/m1/parts/body.stl' },
        { relativePath: 'readme.txt', storagePath: 'models/m1/readme.txt' },
      ],
      storage,
    );

    const archiveData = buffer(archive);
    await archive.finalize();
    const entries = await readZipEntries(await archiveData);

    expect(entries).toEqual(
      new Map([
        ['parts/body.stl', 'solid body'],
        ['readme.txt', 'Print slowly'],
      ]),
    );
    expect(retrieveStream).toHaveBeenCalledTimes(2);
  });
});
