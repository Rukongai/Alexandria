import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SplitFolderDialog } from './SplitFolderDialog';

function deferredPromise() {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe('SplitFolderDialog', () => {
  it('explains the move, prefills the basename, and cannot close while submitting', async () => {
    const request = deferredPromise();
    const onConfirm = vi.fn(() => request.promise);
    const onOpenChange = vi.fn();
    render(
      <SplitFolderDialog
        open
        folderPath="variants/large"
        initialName="large"
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    );

    const dialog = screen.getByRole('dialog');
    expect(screen.getByLabelText('New model name')).toHaveValue('large');
    expect(dialog).toHaveTextContent('become its root contents');
    expect(dialog).toHaveTextContent('Metadata and collection memberships stay with the current model');

    fireEvent.change(screen.getByLabelText('New model name'), {
      target: { value: 'Large Benchy' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Model' }));

    expect(onConfirm).toHaveBeenCalledWith('Large Benchy');
    expect(within(dialog).getByRole('button', { name: 'Splitting…' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(dialog).toHaveAttribute('aria-busy', 'true');
    expect(within(dialog).queryByRole('button', { name: 'Close dialog' })).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();

    request.resolve();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
