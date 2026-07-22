import * as React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertTriangle, Download, FileText, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { buttonVariants } from '../ui/button';
import { formatFileSize } from '../../lib/format';
import { cn } from '../../lib/utils';
import type { TextFileRef } from '../../lib/model-files';

const MAX_PREVIEW_BYTES = 1024 * 1024;

interface TextFilePreviewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: TextFileRef | null;
}

type PreviewState =
  | { status: 'idle'; content: '' }
  | { status: 'loading'; content: '' }
  | { status: 'loaded'; content: string }
  | { status: 'error'; content: ''; message: string };

function downloadUrl(file: TextFileRef): string {
  return `${file.url}?download=1`;
}

export function TextFilePreviewModal({
  open,
  onOpenChange,
  file,
}: TextFilePreviewModalProps) {
  const [state, setState] = React.useState<PreviewState>({ status: 'idle', content: '' });
  const isTooLarge = Boolean(file?.sizeBytes && file.sizeBytes > MAX_PREVIEW_BYTES);

  React.useEffect(() => {
    if (!open || !file) {
      setState({ status: 'idle', content: '' });
      return;
    }

    if (isTooLarge) {
      setState({
        status: 'error',
        content: '',
        message: `This file is ${formatFileSize(file.sizeBytes ?? 0)}. Preview supports files up to ${formatFileSize(MAX_PREVIEW_BYTES)}.`,
      });
      return;
    }

    const controller = new AbortController();
    setState({ status: 'loading', content: '' });

    fetch(file.url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Preview failed with status ${response.status}`);
        }
        return response.text();
      })
      .then((content) => {
        setState({ status: 'loaded', content });
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState({
          status: 'error',
          content: '',
          message: error instanceof Error ? error.message : 'Preview failed',
        });
      });

    return () => controller.abort();
  }, [file, isTooLarge, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[82vh] w-[92vw] max-w-4xl flex-col gap-0 overflow-hidden p-0">
        <div className="flex min-w-0 items-center gap-2 border-b border-border px-5 py-3 pr-12">
          <FileText className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <DialogTitle className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
            {file?.name ?? 'Text preview'}
          </DialogTitle>
          {file?.sizeBytes !== undefined && (
            <span className="flex-shrink-0 text-xs text-muted-foreground">
              {formatFileSize(file.sizeBytes)}
            </span>
          )}
          {file && (
            <a
              href={downloadUrl(file)}
              download={file.name}
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-8 gap-1.5')}
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </a>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-background">
          {state.status === 'loading' && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
              <Loader2 className="h-7 w-7 animate-spin" />
              <span className="text-sm">Loading preview...</span>
            </div>
          )}

          {state.status === 'error' && (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
              <AlertTriangle className="h-8 w-8 text-destructive/70" />
              <p className="text-sm font-medium text-foreground">Couldn&apos;t preview this file</p>
              <p className="max-w-md text-xs">{state.message}</p>
            </div>
          )}

          {state.status === 'loaded' && file?.isMarkdown && (
            <div className="px-6 py-5 text-sm leading-6 text-foreground [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_h1]:mb-4 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-lg [&_h3]:font-semibold [&_hr]:my-6 [&_hr]:border-border [&_li]:my-1 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-3 [&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{state.content}</ReactMarkdown>
            </div>
          )}

          {state.status === 'loaded' && !file?.isMarkdown && (
            <pre className="min-h-full whitespace-pre-wrap break-words p-5 font-mono text-xs leading-5 text-foreground">
              {state.content}
            </pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
