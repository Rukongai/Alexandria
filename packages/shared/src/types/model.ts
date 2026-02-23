export type ModelSourceType = 'zip_upload' | 'folder_import' | 'manual';
export type ModelStatus = 'processing' | 'ready' | 'error';
export type FileType = 'stl' | 'image' | 'document' | 'other';

export interface Model {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  userId: string;
  sourceType: ModelSourceType;
  status: ModelStatus;
  originalFilename: string | null;
  totalSizeBytes: number;
  fileCount: number;
  fileHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelFile {
  id: string;
  modelId: string;
  filename: string;
  relativePath: string;
  fileType: FileType;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  hash: string;
  createdAt: string;
}

export interface Thumbnail {
  id: string;
  sourceFileId: string;
  storagePath: string;
  width: number;
  height: number;
  format: string;
  createdAt: string;
}

export interface ModelCard {
  id: string;
  name: string;
  slug: string;
  thumbnailUrl: string | null;
  metadata: import('./metadata').MetadataValue[];
  fileCount: number;
  totalSizeBytes: number;
  status: ModelStatus;
  createdAt: string;
}

export interface ModelDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  thumbnailUrl: string | null;
  metadata: import('./metadata').MetadataValue[];
  sourceType: ModelSourceType;
  originalFilename: string | null;
  fileCount: number;
  totalSizeBytes: number;
  status: ModelStatus;
  collections: import('./collection').CollectionSummary[];
  images: ImageFile[];
  createdAt: string;
  updatedAt: string;
}

export interface ImageFile {
  id: string;
  filename: string;
  thumbnailUrl: string;
  originalUrl: string;
}

export interface FileTreeNode {
  name: string;
  type: 'file' | 'directory';
  fileType?: FileType;
  sizeBytes?: number;
  id?: string;
  children?: FileTreeNode[];
}

export interface UpdateModelRequest {
  name?: string;
  description?: string | null;
}

export interface JobStatus {
  modelId: string;
  status: ModelStatus;
  progress: number | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

export type ImportStrategy = 'hardlink' | 'copy' | 'move';
export type ImportPhase = 'scanning' | 'importing' | 'processing' | 'complete' | 'error';

export interface ImportConfig {
  sourcePath: string;
  pattern: string;
  strategy: ImportStrategy;
  deleteAfterUpload?: boolean;
}

export interface ParsedPatternSegment {
  type: 'collection' | 'metadata' | 'model';
  metadataSlug?: string;
}

export interface ImportJob {
  modelId: string;
  status: ModelStatus;
  strategy: ImportStrategy;
  totalFiles: number;
  processedFiles: number;
  failedFiles: number;
  phase: ImportPhase;
  startedAt: string;
  completedAt: string | null;
}

export interface ModelSearchParams {
  q?: string;
  tags?: string;
  collectionId?: string;
  fileType?: FileType;
  status?: ModelStatus;
  sort?: 'name' | 'createdAt' | 'totalSizeBytes';
  sortDir?: 'asc' | 'desc';
  cursor?: string;
  pageSize?: number;
  metadataFilters?: Record<string, string>;
}
