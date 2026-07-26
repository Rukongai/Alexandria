import { describe, expect, it } from 'vitest';
import type { ImportFileLayoutPlan } from '@alexandria/shared';
import type { FileManifest } from './file-processing.service.js';
import { applyImportFileLayout } from './import-session.service.js';

function manifest(): FileManifest {
  return {
    entries: [
      {
        filename: 'body.stl',
        relativePath: 'Standard/body.stl',
        fileType: 'stl',
        mimeType: 'model/stl',
        sizeBytes: 10,
        hash: 'a'.repeat(64),
      },
      {
        filename: 'render.png',
        relativePath: 'Renders/NSFW/render.png',
        fileType: 'image',
        mimeType: 'image/png',
        sizeBytes: 20,
        hash: 'b'.repeat(64),
      },
      {
        filename: 'readme.txt',
        relativePath: 'readme.txt',
        fileType: 'document',
        mimeType: 'text/plain',
        sizeBytes: 30,
        hash: 'c'.repeat(64),
      },
      {
        filename: 'alternate.obj',
        relativePath: 'Standard/alternate.obj',
        fileType: 'other',
        mimeType: 'application/octet-stream',
        sizeBytes: 10,
        hash: 'd'.repeat(64),
      },
    ],
    totalSizeBytes: 70,
  };
}

function layout(overrides: Partial<ImportFileLayoutPlan> = {}): ImportFileLayoutPlan {
  return {
    rootFolders: ['Model', 'Images'],
    prefixMappings: [
      { sourcePrefix: '', destinationPrefix: 'Model/Standard' },
      { sourcePrefix: 'Renders', destinationPrefix: 'Images/Renders' },
      { sourcePrefix: 'Standard', destinationPrefix: 'Model/Standard' },
    ],
    ...overrides,
  };
}

describe('applyImportFileLayout', () => {
  it('uses exact overrides then longest prefixes while preserving source paths', () => {
    const result = applyImportFileLayout(manifest(), layout({
      fileMappings: [{ sourcePath: 'readme.txt', destinationPath: 'Model/Documentation/readme.txt' }],
    }));

    expect(result.entries.map((entry) => ({
      source: entry.sourceRelativePath,
      destination: entry.relativePath,
      filename: entry.filename,
    }))).toEqual([
      { source: 'Standard/body.stl', destination: 'Model/Standard/body.stl', filename: 'body.stl' },
      { source: 'Renders/NSFW/render.png', destination: 'Images/Renders/NSFW/render.png', filename: 'render.png' },
      { source: 'readme.txt', destination: 'Model/Documentation/readme.txt', filename: 'readme.txt' },
      { source: 'Standard/alternate.obj', destination: 'Model/Standard/alternate.obj', filename: 'alternate.obj' },
    ]);
  });

  it.each([
    ['image below Model', [{ sourcePath: 'Renders/NSFW/render.png', destinationPath: 'Model/render.png' }]],
    ['printable model below Images', [{ sourcePath: 'Standard/body.stl', destinationPath: 'Images/body.stl' }]],
    ['OBJ model below Images', [{ sourcePath: 'Standard/alternate.obj', destinationPath: 'Images/alternate.obj' }]],
  ])('rejects an %s', (_label, fileMappings) => {
    expect(() => applyImportFileLayout(manifest(), layout({ fileMappings })))
      .toThrow(/must be organized below/);
  });

  it('rejects a manifest file that no mapping covers', () => {
    expect(() => applyImportFileLayout(manifest(), layout({
      prefixMappings: [{ sourcePrefix: 'Standard', destinationPrefix: 'Model/Standard' }],
    }))).toThrow(/does not organize/);
  });

  it.each([
    [
      'case-insensitive duplicate destinations',
      [
        { sourcePath: 'Standard/body.stl', destinationPath: 'Model/Standard/same.stl' },
        { sourcePath: 'readme.txt', destinationPath: 'model/standard/SAME.stl' },
      ],
    ],
    [
      'file and descendant destination conflicts',
      [
        { sourcePath: 'Standard/body.stl', destinationPath: 'Model/Standard/item' },
        { sourcePath: 'readme.txt', destinationPath: 'Model/Standard/item/readme.txt' },
      ],
    ],
    [
      'file and non-adjacent descendant destination conflicts',
      [
        { sourcePath: 'Standard/body.stl', destinationPath: 'Model/a' },
        { sourcePath: 'Renders/NSFW/render.png', destinationPath: 'Images/render.png' },
        { sourcePath: 'readme.txt', destinationPath: 'Model/a-0/readme.txt' },
        { sourcePath: 'Standard/alternate.obj', destinationPath: 'Model/a/alternate.obj' },
      ],
    ],
  ])('rejects %s', (_label, fileMappings) => {
    expect(() => applyImportFileLayout(manifest(), layout({ fileMappings })))
      .toThrow(/destination/i);
  });

  it('rejects missing sources and paths outside the required roots', () => {
    expect(() => applyImportFileLayout(manifest(), layout({
      fileMappings: [{ sourcePath: 'missing.stl', destinationPath: 'Model/missing.stl' }],
    }))).toThrow(/does not exist/);
    expect(() => applyImportFileLayout(manifest(), layout({
      prefixMappings: [{ sourcePrefix: '', destinationPrefix: 'Other' }],
    }))).toThrow(/below Model or Images/);
  });
});
