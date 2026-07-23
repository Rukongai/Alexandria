import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MultipartArchiveUpload, validateMultipartSelection } from './multipart-archive-upload';

const mutateAsync = vi.fn();

vi.mock('../../hooks/use-import-sessions', () => ({
  useStartMultipartScan: () => ({
    isPending: false,
    mutateAsync,
  }),
}));

function archive(name: string, contents = 'archive'): File {
  return new File([contents], name, { type: 'application/octet-stream' });
}

describe('validateMultipartSelection', () => {
  it.each([
    'model.zip',
    'model.RAR',
    'model.7z',
    'model.tar.gz',
    'model.TGZ',
  ])('should accept supported complete archive %s when combining', (filename) => {
    expect(validateMultipartSelection(
      [archive(filename), archive('second.zip')],
      'combine',
    )).toBeNull();
  });

  it('should reject unsupported files when combining archives', () => {
    expect(validateMultipartSelection(
      [archive('model.zip'), archive('notes.txt')],
      'combine',
    )).toContain('notes.txt is not a supported archive');
  });

  it('should direct split RAR parts away from combine mode', () => {
    expect(validateMultipartSelection(
      [archive('Nympha3D - 2026-02.part1.rar'), archive('Nympha3D - 2026-02.part2.rar')],
      'combine',
    )).toBe(
      'Nympha3D - 2026-02.part1.rar is part of a split RAR. Choose Split archive mode and select every part.',
    );
  });

  it('should direct an empty-base split RAR part away from combine mode', () => {
    expect(validateMultipartSelection(
      [archive('.part1.rar'), archive('second.rar')],
      'combine',
    )).toBe(
      '.part1.rar is part of a split RAR. Choose Split archive mode and select every part.',
    );
  });

  it('should accept a complete classic split ZIP set', () => {
    expect(validateMultipartSelection(
      [archive('dragon.z01'), archive('dragon.z02'), archive('dragon.zip')],
      'split',
    )).toBeNull();
  });

  it.each([
    ['classic', ['Dragon.Z01', 'DRAGON.z02', 'dragon.ZIP']],
    ['numbered', ['Dragon.ZIP.001', 'DRAGON.zip.002']],
  ])('should accept a complete %s split ZIP set case-insensitively', (_label, filenames) => {
    expect(validateMultipartSelection(
      filenames.map((filename) => archive(filename)),
      'split',
    )).toBeNull();
  });

  it.each([
    ['unpadded', ['Nympha3D - 2026-02.part1.rar', 'Nympha3D - 2026-02.part2.rar']],
    ['zero-padded', ['Dragon.PART01.RAR', 'DRAGON.part02.rar']],
  ])('should accept a complete %s split RAR set case-insensitively', (_label, filenames) => {
    expect(validateMultipartSelection(
      filenames.map((filename) => archive(filename)),
      'split',
    )).toBeNull();
  });

  it('should accept split RAR part numbers that grow beyond the part 1 width', () => {
    const filenames = Array.from(
      { length: 10 },
      (_, index) => `dragon.part${index + 1}.rar`,
    );

    expect(validateMultipartSelection(
      filenames.map((filename) => archive(filename)),
      'split',
    )).toBeNull();
  });

  it('should accept two-digit split RAR padding across part09 to part10', () => {
    const filenames = Array.from(
      { length: 10 },
      (_, index) => `dragon.part${String(index + 1).padStart(2, '0')}.rar`,
    );

    expect(validateMultipartSelection(
      filenames.map((filename) => archive(filename)),
      'split',
    )).toBeNull();
  });

  it('should report a missing numbered ZIP part', () => {
    expect(validateMultipartSelection(
      [archive('dragon.zip.001'), archive('dragon.zip.003')],
      'split',
    )).toBe('Split archive part 002 is missing.');
  });

  it('should report a missing split RAR part using the set padding', () => {
    expect(validateMultipartSelection(
      [archive('dragon.part01.rar'), archive('dragon.part03.rar')],
      'split',
    )).toBe('Split archive part 02 is missing.');
  });

  it.each([
    ['duplicate numbered names/numbers', ['dragon.zip.001', 'DRAGON.ZIP.001']],
    ['duplicate classic names/numbers', ['dragon.z01', 'DRAGON.Z01', 'dragon.zip']],
    ['mixed schemes', ['dragon.z01', 'dragon.zip', 'dragon.zip.001']],
    ['unrelated bases', ['dragon.z01', 'other.zip']],
    ['a missing terminal zip', ['dragon.z01', 'dragon.z02']],
    ['an unrelated member', ['dragon.z01', 'dragon.zip', 'notes.txt']],
    ['classic part zero', ['dragon.z00', 'dragon.zip']],
    ['classic part above 99', ['dragon.z100', 'dragon.zip']],
    ['numbered part zero', ['dragon.zip.000', 'dragon.zip.001']],
    ['numbered part above 999', ['dragon.zip.001', 'dragon.zip.1000']],
    ['mixed ZIP and RAR schemes', ['dragon.zip.001', 'dragon.part002.rar']],
    ['mixed RAR padding', ['dragon.part1.rar', 'dragon.part02.rar']],
    ['duplicate RAR part numbers', ['dragon.part1.rar', 'DRAGON.PART1.RAR']],
    ['unrelated RAR bases', ['dragon.part1.rar', 'wyvern.part2.rar']],
    ['RAR part zero', ['dragon.part0.rar', 'dragon.part1.rar']],
    ['RAR part above the set limit', ['dragon.part1.rar', 'dragon.part101.rar']],
    ['an unrelated RAR member', ['dragon.part1.rar', 'notes.txt']],
  ])('should reject %s in split mode', (_label, filenames) => {
    expect(validateMultipartSelection(
      filenames.map((filename) => archive(filename)),
      'split',
    )).not.toBeNull();
  });
});

describe('MultipartArchiveUpload', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
  });

  it('should explain that grouped uploads create one review session', () => {
    render(<MultipartArchiveUpload currentLibraryId="library-a" onSessionCreated={vi.fn()} />);

    expect(screen.getByRole('radio', { name: /Combine archives/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Split archive/ })).not.toBeChecked();
    expect(screen.getByText(/split ZIP or RAR/i)).toBeVisible();
    expect(screen.getByText(/ordinary multi-select under Archive upload/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Upload as one model' })).toBeDisabled();
  });

  it('should validate selected files against the chosen mode', () => {
    render(<MultipartArchiveUpload currentLibraryId="library-a" onSessionCreated={vi.fn()} />);
    const input = screen.getByLabelText('Select multipart archive files');

    fireEvent.change(input, {
      target: { files: [archive('dragon.z01'), archive('dragon.zip')] },
    });

    expect(screen.getByRole('alert')).toHaveTextContent('dragon.z01 is not a supported archive');
    fireEvent.click(screen.getByRole('radio', { name: /Split archive/ }));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Upload as one model' })).toBeEnabled();
  });

  it('should accept a modern split RAR selection in split archive mode', () => {
    render(<MultipartArchiveUpload currentLibraryId="library-a" onSessionCreated={vi.fn()} />);
    const input = screen.getByLabelText('Select multipart archive files');

    fireEvent.click(screen.getByRole('radio', { name: /Split archive/ }));
    fireEvent.change(input, {
      target: {
        files: [
          archive('Nympha3D - 2026-02.part1.rar'),
          archive('Nympha3D - 2026-02.part2.rar'),
        ],
      },
    });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Upload as one model' })).toBeEnabled();
  });

  it('should explain how to upload split RAR files selected in combine mode', () => {
    render(<MultipartArchiveUpload currentLibraryId="library-a" onSessionCreated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Select multipart archive files'), {
      target: {
        files: [
          archive('Nympha3D - 2026-02.part1.rar'),
          archive('Nympha3D - 2026-02.part2.rar'),
        ],
      },
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'is part of a split RAR. Choose Split archive mode and select every part.',
    );
    expect(screen.getByRole('button', { name: 'Upload as one model' })).toBeDisabled();
  });

  it('should remove individual files and reset the selection', () => {
    render(<MultipartArchiveUpload currentLibraryId="library-a" onSessionCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Select multipart archive files'), {
      target: { files: [archive('one.zip'), archive('two.zip'), archive('three.zip')] },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Remove two.zip' }));
    expect(screen.queryByText('two.zip')).toBeNull();
    expect(screen.getByText('2 of 100 · 14 B total')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.queryByRole('heading', { name: 'Selected files' })).toBeNull();
  });

  it('should submit all files once and return the created session', async () => {
    const onSessionCreated = vi.fn();
    mutateAsync.mockResolvedValue({ sessionId: 'new-session' });
    render(<MultipartArchiveUpload currentLibraryId="library-a" onSessionCreated={onSessionCreated} />);
    const files = [archive('one.zip'), archive('two.zip')];

    fireEvent.change(screen.getByLabelText('Select multipart archive files'), {
      target: { files },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload as one model' }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        files,
        mode: 'combine',
        currentLibraryId: 'library-a',
        onFinalizing: expect.any(Function),
        onProgress: expect.any(Function),
        signal: expect.any(AbortSignal),
      });
      expect(onSessionCreated).toHaveBeenCalledWith('new-session', 'library-a');
    });
  });

  it('should cancel the grouped upload and ignore stale success callbacks', async () => {
    let uploadSignal: AbortSignal | undefined;
    let reportProgress: ((pct: number) => void) | undefined;
    let resolveUpload: ((result: { sessionId: string }) => void) | undefined;
    mutateAsync.mockImplementation(({
      signal,
      onProgress,
    }: {
      signal: AbortSignal;
      onProgress: (pct: number) => void;
    }) => {
      uploadSignal = signal;
      reportProgress = onProgress;
      return new Promise((resolve) => {
        resolveUpload = resolve;
      });
    });
    const onSessionCreated = vi.fn();
    render(<MultipartArchiveUpload currentLibraryId="library-a" onSessionCreated={onSessionCreated} />);
    const files = [archive('one.zip'), archive('two.zip')];

    fireEvent.change(screen.getByLabelText('Select multipart archive files'), {
      target: { files },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload as one model' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel grouped upload' }));

    expect(uploadSignal?.aborted).toBe(true);
    expect(screen.queryByRole('progressbar', {
      name: 'Multipart archive upload progress',
    })).toBeNull();
    expect(screen.getByText('2 of 100 · 14 B total')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Upload as one model' })).toBeEnabled();

    await act(async () => {
      reportProgress?.(91);
      resolveUpload?.({ sessionId: 'stale-session' });
    });

    expect(onSessionCreated).not.toHaveBeenCalled();
    expect(screen.queryByRole('progressbar', {
      name: 'Multipart archive upload progress',
    })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('should pin the grouped upload to its starting library and close cancellation while finalizing', async () => {
    let resolveUpload: ((result: { sessionId: string }) => void) | undefined;
    mutateAsync.mockImplementation(() => new Promise((resolve) => {
      resolveUpload = resolve;
    }));
    const onSessionCreated = vi.fn();
    const { rerender } = render(
      <MultipartArchiveUpload currentLibraryId="library-a" onSessionCreated={onSessionCreated} />,
    );
    const files = [archive('one.zip'), archive('two.zip')];

    fireEvent.change(screen.getByLabelText('Select multipart archive files'), {
      target: { files },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload as one model' }));
    const [variables] = mutateAsync.mock.calls[0];
    rerender(
      <MultipartArchiveUpload currentLibraryId="library-b" onSessionCreated={onSessionCreated} />,
    );
    act(() => variables.onFinalizing());

    expect(variables.currentLibraryId).toBe('library-a');
    expect(screen.getByText('Finalizing')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Cancel grouped upload' })).toBeNull();
    expect(variables.signal.aborted).toBe(false);

    await act(async () => resolveUpload?.({ sessionId: 'group-session' }));
    expect(onSessionCreated).toHaveBeenCalledWith('group-session', 'library-a');
    expect(variables.signal.aborted).toBe(false);
  });

  it('should reset the live announcement before cancelling the same group again', async () => {
    mutateAsync.mockImplementation(() => new Promise(() => {}));
    render(<MultipartArchiveUpload currentLibraryId="library-a" onSessionCreated={vi.fn()} />);
    const files = [archive('one.zip'), archive('two.zip')];

    fireEvent.change(screen.getByLabelText('Select multipart archive files'), {
      target: { files },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload as one model' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel grouped upload' }));
    expect(screen.getByRole('status')).toHaveTextContent('Grouped upload cancelled.');

    fireEvent.click(screen.getByRole('button', { name: 'Upload as one model' }));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel grouped upload' }));
    expect(screen.getByRole('status')).toHaveTextContent('Grouped upload cancelled.');
  });
});
