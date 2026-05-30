import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ModelViewer3DModal } from './ModelViewer3DModal';
import type { StlFileRef } from '../../lib/model-files';

// The real scene imports three.js + WebGL, which jsdom can't run. Mock it with
// a lightweight stub that echoes the url it was asked to render.
vi.mock('./ModelViewer3DScene', () => ({
  default: ({ url }: { url: string }) => <div data-testid="scene" data-url={url} />,
}));

const STLS: StlFileRef[] = [
  { name: 'body.stl', relativePath: 'body.stl', url: '/api/files/models/m1/body.stl' },
  { name: 'base.stl', relativePath: 'base.stl', url: '/api/files/models/m1/base.stl' },
];

function setup(open: boolean, initial: StlFileRef | null = STLS[0]) {
  const onOpenChange = vi.fn();
  render(
    <ModelViewer3DModal
      open={open}
      onOpenChange={onOpenChange}
      stlFiles={STLS}
      initialStl={initial}
    />,
  );
  return { onOpenChange };
}

describe('ModelViewer3DModal', () => {
  it('renders nothing when closed', () => {
    setup(false);
    expect(screen.queryByTestId('scene')).not.toBeInTheDocument();
  });

  it('shows the initial STL name and loads its scene when open', async () => {
    setup(true, STLS[0]);
    expect(await screen.findByRole('heading', { name: 'body.stl' })).toBeInTheDocument();
    const scene = await screen.findByTestId('scene');
    expect(scene).toHaveAttribute('data-url', '/api/files/models/m1/body.stl');
  });

  it('shows an "X of N" indicator and a switcher chip per STL', () => {
    setup(true, STLS[0]);
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /body\.stl/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /base\.stl/ })).toBeInTheDocument();
  });

  it('switches the active STL when a chip is clicked', async () => {
    setup(true, STLS[0]);
    fireEvent.click(screen.getByRole('button', { name: /base\.stl/ }));

    await waitFor(() => {
      expect(screen.getByTestId('scene')).toHaveAttribute(
        'data-url',
        '/api/files/models/m1/base.stl',
      );
    });
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
  });

  it('calls onOpenChange(false) when the close button is clicked', () => {
    const { onOpenChange } = setup(true, STLS[0]);
    fireEvent.click(screen.getByRole('button', { name: /close dialog/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
