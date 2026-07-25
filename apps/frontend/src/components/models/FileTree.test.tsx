import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { FileTreeNode } from '@alexandria/shared';
import { FileTree } from './FileTree';

const TREE: FileTreeNode[] = [
  {
    name: 'parts',
    type: 'directory',
    isDuplicate: false,
    children: [
      {
        name: 'body.stl',
        type: 'file',
        fileType: 'stl',
        sizeBytes: 100,
        id: 's1',
        isDuplicate: false,
      },
    ],
  },
  {
    name: 'readme.txt',
    type: 'file',
    fileType: 'document',
    sizeBytes: 10,
    id: 'd1',
    isDuplicate: false,
  },
];

function deferredPromise() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('FileTree', () => {
  it('shows full file and folder names as hover tooltips', () => {
    render(<FileTree tree={TREE} modelId="m1" />);

    expect(screen.getByText('parts')).toHaveAttribute('title', 'parts');
    expect(screen.getByText('body.stl')).toHaveAttribute('title', 'body.stl');
    expect(screen.getByText('readme.txt')).toHaveAttribute('title', 'readme.txt');
  });

  it('shows a duplicate indicator on marked files without marking their directory', () => {
    render(
      <FileTree
        tree={[
          {
            name: 'duplicates',
            type: 'directory',
            isDuplicate: false,
            children: [
              {
                name: 'copy.stl',
                type: 'file',
                fileType: 'stl',
                id: 'duplicate-file',
                isDuplicate: true,
              },
            ],
          },
        ]}
        modelId="m1"
      />,
    );

    expect(screen.getAllByText('Duplicate')).toHaveLength(1);
    expect(screen.getByText('Duplicate').parentElement?.textContent).toContain('copy.stl');
    expect(screen.getByText('duplicates').parentElement?.textContent).not.toContain('Duplicate');
  });

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

  it('offers extraction for a nested archive file', () => {
    const onExtractArchive = vi.fn();
    render(
      <FileTree
        tree={[
          {
            name: 'parts',
            type: 'directory',
            isDuplicate: false,
            children: [
              {
                name: 'alternate-parts.tar.gz',
                type: 'file',
                fileType: 'other',
                id: 'a1',
                isDuplicate: false,
              },
            ],
          },
        ]}
        modelId="m1"
        onExtractArchive={onExtractArchive}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Extract alternate-parts.tar.gz' }));

    expect(onExtractArchive).toHaveBeenCalledWith('a1', 'alternate-parts.tar.gz');
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
        tree={[
          {
            name: 'docs',
            type: 'directory',
            isDuplicate: false,
            children: [
              {
                name: 'README.md',
                type: 'file',
                fileType: 'document',
                id: 'md1',
                isDuplicate: false,
              },
            ],
          },
        ]}
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
        isDuplicate: false,
        children: [
          {
            name: 'painted',
            type: 'directory',
            isDuplicate: false,
            children: [
              {
                name: 'cover.png',
                type: 'file',
                fileType: 'image',
                sizeBytes: 42,
                id: 'img-1',
                isDuplicate: false,
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

  it('shows an accessible operation status while file actions are pending', () => {
    const { container } = render(
      <FileTree
        tree={TREE}
        modelId="m1"
        disabled
        operationStatus="Renaming folder…"
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Renaming folder…');
    expect(container.firstElementChild).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Create folder' })).toBeDisabled();
  });

  it('offers non-destructive 7z compression from a folder action menu', () => {
    const onCompressFolder = vi.fn();
    const confirm = vi.spyOn(window, 'confirm');
    render(<FileTree tree={TREE} modelId="m1" onCompressFolder={onCompressFolder} />);

    fireEvent.click(screen.getByRole('button', { name: 'Actions for folder parts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Compress to 7z' }));

    expect(onCompressFolder).toHaveBeenCalledWith('parts', 'parts');
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('keeps the move dialog open with a busy indicator until the move completes', async () => {
    const move = deferredPromise();
    const onMoveFolder = vi.fn(() => move.promise);
    render(<FileTree tree={TREE} modelId="m1" onMoveFolder={onMoveFolder} />);

    fireEvent.click(screen.getByRole('button', { name: 'Actions for folder parts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));

    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));

    expect(onMoveFolder).toHaveBeenCalledWith('parts', '');
    expect(within(dialog).getByRole('button', { name: 'Moving…' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(dialog).toHaveAttribute('aria-busy', 'true');

    expect(within(dialog).queryByRole('button', { name: 'Close dialog' })).not.toBeInTheDocument();

    move.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps the move dialog open for retry when the move fails', async () => {
    const move = deferredPromise();
    const onMoveFolder = vi.fn(() => move.promise);
    render(<FileTree tree={TREE} modelId="m1" onMoveFolder={onMoveFolder} />);

    fireEvent.click(screen.getByRole('button', { name: 'Actions for folder parts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Move' }));

    move.reject(new Error('Move failed'));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Move' })).toBeEnabled();
    });
  });

  it('requests a split with the full nested folder path and folder basename', () => {
    const onSplitFolder = vi.fn();
    render(
      <FileTree
        tree={[
          {
            name: 'variants',
            type: 'directory',
            isDuplicate: false,
            children: [
              {
                name: 'large',
                type: 'directory',
                isDuplicate: false,
                children: [
                  {
                    name: 'body.stl',
                    type: 'file',
                    fileType: 'stl',
                    id: 's1',
                    isDuplicate: false,
                  },
                ],
              },
            ],
          },
        ]}
        modelId="m1"
        onSplitFolder={onSplitFolder}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Actions for folder large' }));
    fireEvent.click(screen.getByRole('button', { name: 'Split into new model…' }));

    expect(onSplitFolder).toHaveBeenCalledWith('variants/large', 'large');
  });
});
