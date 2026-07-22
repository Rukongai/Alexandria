/**
 * Upload and ingestion types.
 */

import type { FileType } from './model.js';

export interface UploadInitResponse {
  uploadId: string;
  chunkSize: number;
  totalChunks: number;
}

export interface ChunkUploadResponse {
  uploadId: string;
  index: number;
  received: number;
  totalChunks: number;
}

export interface UploadCompleteResponse {
  modelId: string;
  jobId: string;
}

export interface UploadProgress {
  modelId: string;
  chunkIndex: number;
  totalChunks: number;
  uploadedBytes: number;
  totalBytes: number;
}

// ---------------------------------------------------------------------------
// Staged upload: scan → review → commit
// ---------------------------------------------------------------------------

/**
 * Lifecycle of a staged archive upload.
 *
 * An archive is first scanned (extracted + inspected) without being committed,
 * then the user reviews/edits the detected metadata, then commits it to a model.
 */
export type ImportSessionStatus =
  | 'scanning'
  | 'ready_for_review'
  | 'committing'
  | 'committed'
  | 'error';

/**
 * A node in the detected folder structure preview.
 */
export interface DetectedFolderNode {
  name: string;
  type: 'folder' | 'file';
  fileType?: FileType;
  children?: DetectedFolderNode[];
}

/**
 * Image file found during staged import scan and available for preview.
 */
export interface DetectedPreviewImage {
  filename: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Best-effort metadata detected during the scan phase. All fields are
 * heuristic and fully editable by the user before commit.
 */
export interface DetectedImportMetadata {
  /** Count of detected sub-models (display only — commit creates one model). */
  modelCount: number;
  fileCount: number;
  totalSizeBytes: number;
  artist: string | null;
  tagsGuessed: string[];
  folderStructure: DetectedFolderNode[];
  previewImages?: DetectedPreviewImage[];
}

/**
 * A staged import session — one uploaded archive awaiting review/commit.
 */
export interface ImportSession {
  id: string;
  originalFilename: string;
  status: ImportSessionStatus;
  detected: DetectedImportMetadata | null;
  modelId: string | null;
  error: string | null;
  createdAt: string;
}

/**
 * Response from initiating a scan (archive upload).
 */
export interface ScanUploadResponse {
  sessionId: string;
}

/**
 * Per-import options toggled in the review form.
 */
export interface UploadOptions {
  markPreSupported?: boolean;
  /** Auto-thumbnails always run during ingestion; this is informational. */
  autoThumbnails?: boolean;
  markNsfw?: boolean;
  skipDuplicatesByHash?: boolean;
}

/**
 * Batch metadata applied to the committed model.
 */
export interface BatchUploadMetadata {
  /** Override the created model's display name. Defaults to the archive filename. */
  modelName?: string;
  /** Optional model description. */
  description?: string | null;
  /** Assign to an existing collection. */
  collectionId?: string;
  /** Or create-and-assign a new collection by name. */
  newCollectionName?: string;
  artist?: string;
  tags?: string[];
  options?: UploadOptions;
}
