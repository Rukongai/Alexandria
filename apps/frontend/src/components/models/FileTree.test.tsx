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
});
