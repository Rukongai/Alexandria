import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readMetadataFile } from './metadata-file.js';

describe('readMetadataFile', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'alexandria-metadata-'));
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  async function writeMetadata(contents: string): Promise<void> {
    await fsPromises.writeFile(path.join(rootDir, 'metadata.json'), contents, 'utf8');
  }

  it('surfaces a valid root metadata.json', async () => {
    await writeMetadata(JSON.stringify({ modelName: 'Dragon', tags: ['dragon'] }));

    expect(await readMetadataFile(rootDir)).toEqual({
      modelName: 'Dragon',
      tags: ['dragon'],
    });
  });

  it('keeps every field the commit endpoint accepts', async () => {
    await writeMetadata(
      JSON.stringify({
        modelName: 'Dragon',
        description: 'A dragon',
        artist: 'Foo Studios',
        tags: ['dragon'],
        metadata: { scale: '32mm' },
      }),
    );

    expect(await readMetadataFile(rootDir)).toEqual({
      modelName: 'Dragon',
      description: 'A dragon',
      artist: 'Foo Studios',
      tags: ['dragon'],
      metadata: { scale: '32mm' },
    });
  });

  it('strips importer-only keys', async () => {
    await writeMetadata(
      JSON.stringify({
        modelName: 'Dragon',
        schemaVersion: 1,
        source: { channelId: -1 },
        result: { modelId: 'abc' },
      }),
    );

    expect(await readMetadataFile(rootDir)).toEqual({ modelName: 'Dragon' });
  });

  it('drops individually invalid fields rather than the whole file', async () => {
    await writeMetadata(
      JSON.stringify({ modelName: 'Dragon', tags: 'not-an-array', artist: 12345 }),
    );

    expect(await readMetadataFile(rootDir)).toEqual({ modelName: 'Dragon' });
  });

  it('returns undefined when the file is absent', async () => {
    expect(await readMetadataFile(rootDir)).toBeUndefined();
  });

  it('returns undefined for unparseable JSON', async () => {
    await writeMetadata('{not json');

    expect(await readMetadataFile(rootDir)).toBeUndefined();
  });

  it('returns undefined for a non-object root', async () => {
    await writeMetadata('[1, 2, 3]');

    expect(await readMetadataFile(rootDir)).toBeUndefined();

    await writeMetadata('"nope"');

    expect(await readMetadataFile(rootDir)).toBeUndefined();
  });

  it('returns undefined for a file over the size cap', async () => {
    await writeMetadata(JSON.stringify({ description: 'x'.repeat(70 * 1024) }));

    expect(await readMetadataFile(rootDir)).toBeUndefined();
  });

  it('ignores a metadata.json nested below the archive root', async () => {
    await fsPromises.mkdir(path.join(rootDir, 'inner'), { recursive: true });
    await fsPromises.writeFile(
      path.join(rootDir, 'inner', 'metadata.json'),
      JSON.stringify({ modelName: 'Nested' }),
      'utf8',
    );

    expect(await readMetadataFile(rootDir)).toBeUndefined();
  });

  it('returns an empty object for a file with no usable fields', async () => {
    await writeMetadata(JSON.stringify({ source: { channelId: -1 } }));

    expect(await readMetadataFile(rootDir)).toEqual({});
  });

  it('returns undefined when metadata.json is a directory', async () => {
    await fsPromises.mkdir(path.join(rootDir, 'metadata.json'));

    expect(await readMetadataFile(rootDir)).toBeUndefined();
  });
});
