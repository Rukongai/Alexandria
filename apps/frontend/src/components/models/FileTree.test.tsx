import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { FileTreeNode } from '@alexandria/shared';
import { FileTree } from './FileTree';

const TREE: FileTreeNode[] = [
  {
    name: 'parts',
    type: 'directory',
    children: [
      { name: 'body.stl', type: 'file', fileType: 'stl', sizeBytes: 100, id: 's1' },
    ],
  },
  { name: 'readme.txt', type: 'file', fileType: 'document', sizeBytes: 10, id: 'd1' },
];

describe('FileTree', () => {
  it('fires onOpenStl with the reconstructed relative path for a nested STL', () => {
    const onOpenStl = vi.fn();
    render(<FileTree tree={TREE} modelId="m1" onOpenStl={onOpenStl} />);

    fireEvent.click(screen.getByRole('button', { name: /view body\.stl in 3d/i }));

    expect(onOpenStl).toHaveBeenCalledWith({
      name: 'body.stl',
      relativePath: 'parts/body.stl',
      url: '/api/files/models/m1/parts/body.stl',
    });
  });

  it('shows no 3D affordance when onOpenStl is omitted', () => {
    render(<FileTree tree={TREE} modelId="m1" />);
    expect(screen.queryByRole('button', { name: /in 3d/i })).not.toBeInTheDocument();
  });

  it('only offers 3D on STL files, not other file types', () => {
    const onOpenStl = vi.fn();
    render(<FileTree tree={TREE} modelId="m1" onOpenStl={onOpenStl} />);
    // readme.txt is a document — no 3D button for it
    expect(screen.getAllByRole('button', { name: /in 3d/i })).toHaveLength(1);
  });

  it('fires onOpenText with the reconstructed relative path for a text file', () => {
    const onOpenText = vi.fn();
    render(<FileTree tree={TREE} modelId="m1" onOpenText={onOpenText} />);

    fireEvent.click(screen.getByRole('button', { name: /preview readme\.txt/i }));

    expect(onOpenText).toHaveBeenCalledWith({
      name: 'readme.txt',
      relativePath: 'readme.txt',
      url: '/api/files/models/m1/readme.txt',
      isMarkdown: false,
      sizeBytes: 10,
    });
  });

  it('marks markdown files for rendered preview', () => {
    const onOpenText = vi.fn();
    render(
      <FileTree
        tree={[{ name: 'docs', type: 'directory', children: [{ name: 'README.md', type: 'file', fileType: 'document', id: 'md1' }] }]}
        modelId="m1"
        onOpenText={onOpenText}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /preview readme\.md/i }));

    expect(onOpenText).toHaveBeenCalledWith({
      name: 'README.md',
      relativePath: 'docs/README.md',
      url: '/api/files/models/m1/docs/README.md',
      isMarkdown: true,
      sizeBytes: undefined,
    });
  });

  it('selects image files and reveals the active image in nested folders', async () => {
    const onSelectImageFile = vi.fn();
    const imageTree: FileTreeNode[] = [
      {
        name: 'renders',
        type: 'directory',
        children: [
          {
            name: 'painted',
            type: 'directory',
            children: [
              {
                name: 'cover.png',
                type: 'file',
                fileType: 'image',
                sizeBytes: 42,
                id: 'img-1',
              },
            ],
          },
        ],
      },
    ];

    render(
      <FileTree
        tree={imageTree}
        modelId="m1"
        selectedImageFileId="img-1"
        onSelectImageFile={onSelectImageFile}
      />,
    );

    const imageRow = await screen.findByRole('button', { name: /select image cover\.png/i });
    expect(imageRow).toHaveAttribute('aria-current', 'true');

    fireEvent.click(imageRow);
    expect(onSelectImageFile).toHaveBeenCalledWith('img-1');
  });
});
