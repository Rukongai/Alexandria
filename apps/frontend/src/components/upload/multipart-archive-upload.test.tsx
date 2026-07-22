import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('should report a missing numbered ZIP part', () => {
    expect(validateMultipartSelection(
      [archive('dragon.zip.001'), archive('dragon.zip.003')],
      'split',
    )).toBe('Split archive part 002 is missing.');
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
    render(<MultipartArchiveUpload onSessionCreated={vi.fn()} />);

    expect(screen.getByRole('radio', { name: /Combine archives/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Split ZIP/ })).not.toBeChecked();
    expect(screen.getByText(/ordinary multi-select under Archive upload/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Upload as one model' })).toBeDisabled();
  });

  it('should validate selected files against the chosen mode', () => {
    render(<MultipartArchiveUpload onSessionCreated={vi.fn()} />);
    const input = screen.getByLabelText('Select multipart archive files');

    fireEvent.change(input, {
      target: { files: [archive('dragon.z01'), archive('dragon.zip')] },
    });

    expect(screen.getByRole('alert')).toHaveTextContent('dragon.z01 is not a supported archive');
    fireEvent.click(screen.getByRole('radio', { name: /Split ZIP/ }));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Upload as one model' })).toBeEnabled();
  });

  it('should remove individual files and reset the selection', () => {
    render(<MultipartArchiveUpload onSessionCreated={vi.fn()} />);
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
    render(<MultipartArchiveUpload onSessionCreated={onSessionCreated} />);
    const files = [archive('one.zip'), archive('two.zip')];

    fireEvent.change(screen.getByLabelText('Select multipart archive files'), {
      target: { files },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload as one model' }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        files,
        mode: 'combine',
        onProgress: expect.any(Function),
      });
      expect(onSessionCreated).toHaveBeenCalledWith('new-session');
    });
  });
});
