import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TextFilePreviewModal } from './TextFilePreviewModal';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TextFilePreviewModal', () => {
  it('renders markdown files as formatted content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('# Readme\n\n- assemble\n- prime'),
      }),
    );

    render(
      <TextFilePreviewModal
        open
        onOpenChange={vi.fn()}
        file={{
          name: 'README.md',
          relativePath: 'README.md',
          url: '/api/files/models/m1/README.md',
          isMarkdown: true,
          sizeBytes: 28,
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Readme' })).toBeInTheDocument();
    });
    expect(screen.getByText('assemble')).toBeInTheDocument();
  });

  it('renders plain text in a preformatted viewer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('line one\nline two'),
      }),
    );

    render(
      <TextFilePreviewModal
        open
        onOpenChange={vi.fn()}
        file={{
          name: 'notes.txt',
          relativePath: 'notes.txt',
          url: '/api/files/models/m1/notes.txt',
          isMarkdown: false,
          sizeBytes: 17,
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/line one/)).toBeInTheDocument();
    });
    expect(screen.getByText(/line two/).tagName).toBe('PRE');
  });
});
