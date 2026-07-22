import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { DropZone } from './DropZone';

const mutate = vi.fn();

vi.mock('../../hooks/use-import-sessions', () => ({
  useStartScan: () => ({ mutate }),
}));

function archive(name: string): File {
  return new File(['archive'], name);
}

describe('DropZone', () => {
  beforeEach(() => {
    mutate.mockReset();
  });

  it('should start one ordinary scan per selected archive', () => {
    const { container } = render(<DropZone />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const first = archive('first.zip');
    const second = archive('second.rar');

    fireEvent.change(input!, { target: { files: [first, second] } });

    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mutate.mock.calls.map(([variables]) => variables.file)).toEqual([first, second]);
    expect(mutate.mock.calls.every(([variables]) =>
      typeof variables.onProgress === 'function')).toBe(true);
  });

  it('should not fold an unrelated file into an ordinary archive upload', () => {
    const { container } = render(<DropZone />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const supported = archive('model.zip');

    fireEvent.change(input!, {
      target: { files: [supported, archive('notes.txt')] },
    });

    expect(mutate).toHaveBeenCalledOnce();
    expect(mutate.mock.calls[0][0].file).toBe(supported);
  });
});
