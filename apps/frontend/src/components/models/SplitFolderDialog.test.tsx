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
        metadata={[
          {
            fieldSlug: 'artist',
            fieldName: 'Artist',
            type: 'text',
            value: 'Printed Obsession',
            displayValue: 'Printed Obsession',
          },
        ]}
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    );

    const dialog = screen.getByRole('dialog');
    expect(screen.getByLabelText('New model name')).toHaveValue('large');
    expect(dialog).toHaveTextContent('become its root contents');
    expect(dialog).toHaveTextContent('Collection memberships stay with the current model');

    fireEvent.change(screen.getByLabelText('New model name'), {
      target: { value: 'Large Benchy' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Model' }));

    expect(onConfirm).toHaveBeenCalledWith('Large Benchy', []);
    expect(within(dialog).getByRole('button', { name: 'Splitting…' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByLabelText('Artist')).toBeDisabled();
    expect(dialog).toHaveAttribute('aria-busy', 'true');
    expect(within(dialog).queryByRole('button', { name: 'Close dialog' })).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();

    request.resolve();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('offers populated metadata unchecked, submits selected fields, and resets on reopen', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    const props = {
      folderPath: 'variants/large',
      initialName: 'large',
      metadata: [
        {
          fieldSlug: 'artist',
          fieldName: 'Artist',
          type: 'text' as const,
          value: 'Printed Obsession',
          displayValue: 'Printed Obsession',
        },
        {
          fieldSlug: 'tags',
          fieldName: 'Tags',
          type: 'multi_enum' as const,
          value: ['functional', 'boats'],
          displayValue: 'Functional, Boats',
        },
        {
          fieldSlug: 'notes',
          fieldName: 'Notes',
          type: 'text' as const,
          value: '',
          displayValue: '',
        },
      ],
      onOpenChange,
      onConfirm,
    };
    const { rerender } = render(<SplitFolderDialog {...props} open />);

    expect(screen.getByText('Printed Obsession')).toBeInTheDocument();
    expect(screen.getByText('Functional, Boats')).toBeInTheDocument();
    expect(screen.queryByLabelText('Notes')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Artist')).not.toBeChecked();
    expect(screen.getByLabelText('Tags')).not.toBeChecked();
    expect(screen.getByLabelText('Artist')).toHaveAccessibleDescription('Printed Obsession');
    expect(screen.getByLabelText('Tags')).toHaveAccessibleDescription('Functional, Boats');

    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getByLabelText('Artist')).toBeChecked();
    expect(screen.getByLabelText('Tags')).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.getByLabelText('Artist')).not.toBeChecked();
    expect(screen.getByLabelText('Tags')).not.toBeChecked();

    fireEvent.click(screen.getByLabelText('Tags'));
    fireEvent.click(screen.getByRole('button', { name: 'Create Model' }));

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith('large', ['tags']);
    });

    rerender(<SplitFolderDialog {...props} open={false} />);
    rerender(<SplitFolderDialog {...props} open />);
    expect(screen.getByLabelText('Tags')).not.toBeChecked();
  });
});
