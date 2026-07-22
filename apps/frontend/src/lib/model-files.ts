import type { FileTreeNode } from '@alexandria/shared';

const MARKDOWN_EXTENSIONS = new Set(['markdown', 'md', 'mdown', 'mkd']);
const TEXT_PREVIEW_EXTENSIONS = new Set([
  ...MARKDOWN_EXTENSIONS,
  'asc',
  'conf',
  'config',
  'css',
  'csv',
  'env',
  'ini',
  'js',
  'json',
  'jsx',
  'log',
  'mjs',
  'properties',
  'readme',
  'rst',
  'scss',
  'sh',
  'toml',
  'ts',
  'tsx',
  'txt',
  'xml',
  'yaml',
  'yml',
]);
const TEXT_PREVIEW_FILENAMES = new Set([
  'authors',
  'changelog',
  'contributing',
  'copying',
  'license',
  'notice',
  'readme',
]);

function getFileExtension(name: string): string {
  const normalized = name.toLowerCase();
  const dotIndex = normalized.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === normalized.length - 1) return normalized;
  return normalized.slice(dotIndex + 1);
}

export function isMarkdownFileName(name: string): boolean {
  return MARKDOWN_EXTENSIONS.has(getFileExtension(name));
}

export function isTextPreviewFileName(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    TEXT_PREVIEW_EXTENSIONS.has(getFileExtension(normalized)) ||
    TEXT_PREVIEW_FILENAMES.has(normalized)
  );
}

function modelFileUrl(modelId: string, segments: string[]): string {
  return `/api/files/models/${modelId}/${segments.map(encodeURIComponent).join('/')}`;
}

/**
 * A loadable reference to a single STL file within a model.
 *
 * `FileTreeNode`s don't carry the relative path (the backend builds the tree
 * by splitting `relativePath` on `/`), so we reconstruct each STL's path by
 * joining its ancestor directory names + its own name. The resulting `url`
 * points at the same-origin file route, so the session cookie is sent
 * automatically by the loader's fetch.
 */
export interface StlFileRef {
  /** File name, e.g. "dragon_base.stl". */
  name: string;
  /** Path relative to the model root, e.g. "parts/dragon_base.stl". */
  relativePath: string;
  /** Fetchable URL: `/api/files/models/{modelId}/{encoded path}`. */
  url: string;
}

export interface TextFileRef {
  /** File name, e.g. "README.md". */
  name: string;
  /** Path relative to the model root, e.g. "docs/README.md". */
  relativePath: string;
  /** Fetchable URL: `/api/files/models/{modelId}/{encoded path}`. */
  url: string;
  /** True when the preview should use the Markdown renderer. */
  isMarkdown: boolean;
  /** Size in bytes when the file tree provided it. */
  sizeBytes?: number;
}

/**
 * Build an STL reference from a model id and the file's path segments
 * (ancestor directory names + file name). Single source of truth for the file
 * URL so the file tree and the discovery walk stay in sync.
 */
export function makeStlRef(modelId: string, segments: string[]): StlFileRef {
  return {
    name: segments[segments.length - 1],
    relativePath: segments.join('/'),
    url: modelFileUrl(modelId, segments),
  };
}

export function makeTextFileRef(
  modelId: string,
  segments: string[],
  sizeBytes?: number,
): TextFileRef {
  const name = segments[segments.length - 1];
  return {
    name,
    relativePath: segments.join('/'),
    url: modelFileUrl(modelId, segments),
    isMarkdown: isMarkdownFileName(name),
    sizeBytes,
  };
}

/**
 * Walk a file tree and collect every STL file with its reconstructed relative
 * path and fetch URL, in depth-first tree order.
 */
export function collectStlFiles(
  tree: FileTreeNode[],
  modelId: string,
): StlFileRef[] {
  const out: StlFileRef[] = [];

  const walk = (nodes: FileTreeNode[], prefix: string[]) => {
    for (const node of nodes) {
      if (node.type === 'directory') {
        walk(node.children ?? [], [...prefix, node.name]);
      } else if (node.fileType === 'stl') {
        out.push(makeStlRef(modelId, [...prefix, node.name]));
      }
    }
  };

  walk(tree, []);
  return out;
}

/** The "primary" STL is the first one found in tree order, or null if none. */
export function getPrimaryStl(stls: StlFileRef[]): StlFileRef | null {
  return stls[0] ?? null;
}
