import { describe, it, expect } from 'vitest';
import type { FileTreeNode } from '@alexandria/shared';
import { collectStlFiles, getPrimaryStl } from './model-files';

const MODEL_ID = 'abc-123';

describe('collectStlFiles', () => {
  it('returns an empty array for an empty tree', () => {
    expect(collectStlFiles([], MODEL_ID)).toEqual([]);
  });

  it('finds a top-level STL and builds its URL', () => {
    const tree: FileTreeNode[] = [
      { name: 'dragon.stl', type: 'file', fileType: 'stl', sizeBytes: 100, id: 'f1' },
    ];
    expect(collectStlFiles(tree, MODEL_ID)).toEqual([
      {
        name: 'dragon.stl',
        relativePath: 'dragon.stl',
        url: `/api/files/models/${MODEL_ID}/dragon.stl`,
      },
    ]);
  });

  it('filters out non-STL files', () => {
    const tree: FileTreeNode[] = [
      { name: 'cover.png', type: 'file', fileType: 'image', id: 'i1' },
      { name: 'body.stl', type: 'file', fileType: 'stl', id: 's1' },
      { name: 'readme.md', type: 'file', fileType: 'document', id: 'd1' },
      { name: 'notes.txt', type: 'file', fileType: 'other', id: 'o1' },
    ];
    const result = collectStlFiles(tree, MODEL_ID);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('body.stl');
  });

  it('reconstructs the full relative path for nested STLs', () => {
    const tree: FileTreeNode[] = [
      {
        name: 'parts',
        type: 'directory',
        children: [
          {
            name: 'left',
            type: 'directory',
            children: [
              { name: 'arm.stl', type: 'file', fileType: 'stl', id: 's1' },
            ],
          },
          { name: 'base.stl', type: 'file', fileType: 'stl', id: 's2' },
        ],
      },
    ];
    const result = collectStlFiles(tree, MODEL_ID);
    expect(result).toEqual([
      {
        name: 'arm.stl',
        relativePath: 'parts/left/arm.stl',
        url: `/api/files/models/${MODEL_ID}/parts/left/arm.stl`,
      },
      {
        name: 'base.stl',
        relativePath: 'parts/base.stl',
        url: `/api/files/models/${MODEL_ID}/parts/base.stl`,
      },
    ]);
  });

  it('preserves depth-first tree order', () => {
    const tree: FileTreeNode[] = [
      { name: 'a.stl', type: 'file', fileType: 'stl', id: '1' },
      {
        name: 'sub',
        type: 'directory',
        children: [{ name: 'b.stl', type: 'file', fileType: 'stl', id: '2' }],
      },
      { name: 'c.stl', type: 'file', fileType: 'stl', id: '3' },
    ];
    expect(collectStlFiles(tree, MODEL_ID).map((s) => s.name)).toEqual([
      'a.stl',
      'b.stl',
      'c.stl',
    ]);
  });

  it('URL-encodes path segments with spaces and special characters', () => {
    const tree: FileTreeNode[] = [
      {
        name: 'pre supports',
        type: 'directory',
        children: [
          { name: 'main body.stl', type: 'file', fileType: 'stl', id: 's1' },
        ],
      },
    ];
    const result = collectStlFiles(tree, MODEL_ID);
    expect(result[0].relativePath).toBe('pre supports/main body.stl');
    expect(result[0].url).toBe(
      `/api/files/models/${MODEL_ID}/pre%20supports/main%20body.stl`,
    );
  });

  it('tolerates directories with no children', () => {
    const tree: FileTreeNode[] = [{ name: 'empty', type: 'directory' }];
    expect(collectStlFiles(tree, MODEL_ID)).toEqual([]);
  });
});

describe('getPrimaryStl', () => {
  it('returns null for an empty list', () => {
    expect(getPrimaryStl([])).toBeNull();
  });

  it('returns the first STL in the list', () => {
    const stls = collectStlFiles(
      [
        { name: 'first.stl', type: 'file', fileType: 'stl', id: '1' },
        { name: 'second.stl', type: 'file', fileType: 'stl', id: '2' },
      ],
      MODEL_ID,
    );
    expect(getPrimaryStl(stls)?.name).toBe('first.stl');
  });
});
