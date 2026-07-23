import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DropZone } from './DropZone';

const mutateAsync = vi.fn();

vi.mock('../../hooks/use-import-sessions', () => ({
  useStartScan: () => ({ mutateAsync }),
}));

function archive(name: string): File {
  return new File(['archive'], name);
}

describe('DropZone', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    mutateAsync.mockImplementation(() => new Promise(() => {}));
  });

  it('should start one ordinary scan per selected archive', () => {
    const { container } = render(<DropZone currentLibraryId="library-a" />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const first = archive('first.zip');
    const second = archive('second.rar');

    fireEvent.change(input!, { target: { files: [first, second] } });

    expect(mutateAsync).toHaveBeenCalledTimes(2);
    expect(mutateAsync.mock.calls.map(([variables]) => variables.file)).toEqual([first, second]);
    expect(mutateAsync.mock.calls.every(([variables]) =>
      typeof variables.onProgress === 'function')).toBe(true);
    expect(mutateAsync.mock.calls.every(([variables]) =>
      variables.currentLibraryId === 'library-a')).toBe(true);
  });

  it('should not fold an unrelated file into an ordinary archive upload', () => {
    const { container } = render(<DropZone currentLibraryId="library-a" />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const supported = archive('model.zip');

    fireEvent.change(input!, {
      target: { files: [supported, archive('notes.txt')] },
    });

    expect(mutateAsync).toHaveBeenCalledOnce();
    expect(mutateAsync.mock.calls[0][0].file).toBe(supported);
  });

  it('should cancel an in-flight upload and ignore its stale callbacks', async () => {
    let resolveUpload: (() => void) | undefined;
    mutateAsync.mockImplementation(() => new Promise<void>((resolve) => {
      resolveUpload = resolve;
    }));
    const { container } = render(<DropZone currentLibraryId="library-a" />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const file = archive('stalled.zip');

    fireEvent.change(input!, { target: { files: [file] } });
    const [variables] = mutateAsync.mock.calls[0];

    act(() => variables.onProgress(23));
    expect(screen.getByText('23%')).toBeVisible();
    expect(screen.getByRole('progressbar', {
      name: 'Upload progress for stalled.zip',
    })).toHaveAttribute('aria-valuenow', '23');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel upload of stalled.zip' }));

    expect(variables.signal).toBeInstanceOf(AbortSignal);
    expect(variables.signal.aborted).toBe(true);
    expect(screen.queryByText('stalled.zip')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('stalled.zip upload cancelled.');

    await act(async () => {
      variables.onProgress(80);
      resolveUpload?.();
    });
    expect(screen.queryByText('stalled.zip')).toBeNull();
    expect(screen.queryByText(/Request aborted/i)).toBeNull();
  });

  it('should keep in-flight rows visible and cancellable in compact mode', () => {
    const { container } = render(<DropZone currentLibraryId="library-a" compact />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');

    fireEvent.change(input!, { target: { files: [archive('still-uploading.zip')] } });

    expect(screen.getByText('still-uploading.zip')).toBeVisible();
    expect(screen.getByRole('button', {
      name: 'Cancel upload of still-uploading.zip',
    })).toBeVisible();
  });

  it('should cancel one concurrent upload without affecting the other', () => {
    const { container } = render(<DropZone currentLibraryId="library-a" />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');

    fireEvent.change(input!, {
      target: { files: [archive('first.zip'), archive('second.zip')] },
    });
    const [firstVariables] = mutateAsync.mock.calls[0];
    const [secondVariables] = mutateAsync.mock.calls[1];

    fireEvent.click(screen.getByRole('button', { name: 'Cancel upload of first.zip' }));

    expect(firstVariables.signal.aborted).toBe(true);
    expect(secondVariables.signal.aborted).toBe(false);
    expect(screen.queryByText('first.zip')).toBeNull();
    expect(screen.getByText('second.zip')).toBeVisible();
  });

  it('should pin an upload to the library selected when it starts', () => {
    const { container, rerender } = render(<DropZone currentLibraryId="library-a" />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');

    fireEvent.change(input!, { target: { files: [archive('pinned.zip')] } });
    rerender(<DropZone currentLibraryId="library-b" />);

    expect(mutateAsync.mock.calls[0][0].currentLibraryId).toBe('library-a');
  });

  it('should close cancellation before finalizing and complete normally', async () => {
    let resolveUpload: ((result: { sessionId: string }) => void) | undefined;
    mutateAsync.mockImplementation(() => new Promise((resolve) => {
      resolveUpload = resolve;
    }));
    const { container } = render(<DropZone currentLibraryId="library-a" />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');

    fireEvent.change(input!, { target: { files: [archive('claimed.zip')] } });
    const [variables] = mutateAsync.mock.calls[0];
    act(() => variables.onFinalizing());

    expect(screen.getByText('Finalizing')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Cancel upload of claimed.zip' })).toBeNull();
    expect(variables.signal.aborted).toBe(false);

    await act(async () => resolveUpload?.({ sessionId: 'session-a' }));
    expect(screen.queryByText('claimed.zip')).toBeNull();
    expect(variables.signal.aborted).toBe(false);
  });

  it('should reset the live announcement before cancelling the same filename again', () => {
    const { container } = render(<DropZone currentLibraryId="library-a" />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const file = archive('repeat.zip');

    fireEvent.change(input!, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel upload of repeat.zip' }));
    expect(screen.getByRole('status')).toHaveTextContent('repeat.zip upload cancelled.');

    fireEvent.change(input!, { target: { files: [file] } });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel upload of repeat.zip' }));
    expect(screen.getByRole('status')).toHaveTextContent('repeat.zip upload cancelled.');
  });
});
