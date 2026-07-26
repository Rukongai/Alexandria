/**
 * Upload and ingestion types.
 */

import type { FileType } from './model.js';
import type { SetModelMetadataRequest } from './metadata.js';

export interface UploadInitResponse {
  uploadId: string;
  expiresAt: string;
}

export interface ChunkUploadResponse {
  received: number;
}

export interface UploadCompleteResponse {
  sessionId: string;
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

export type ImportCommitPhase =
  | 'queued'
  | 'storing_files'
  | 'saving_records'
  | 'generating_thumbnails'
  | 'applying_metadata'
  | 'complete';

/**
 * Live progress for the commit phase of a staged import.
 *
 * File and byte counters describe managed-storage transfer. `percent` is an
 * overall pipeline percentage: storage occupies 0-80 and the remaining
 * phases advance it to 100.
 */
export interface ImportCommitProgress {
  phase: ImportCommitPhase;
  percent: number;
  completedFiles: number;
  totalFiles: number;
  completedBytes: number;
  totalBytes: number;
  currentFilename: string | null;
}

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

export interface DetectedArchiveFile {
  filename: string;
  relativePath: string;
  sizeBytes: number;
}

/**
 * A `metadata.json` found at the root of an uploaded archive.
 *
 * Prefill only — never applied automatically at commit. The client always
 * sends the metadata it intends, so detecting this file cannot change the
 * outcome of any upload.
 *
 * `collectionId` is deliberately excluded: a collection UUID is meaningful
 * only in the library it came from, so prefilling one would submit a
 * destination the picker never displayed. `newCollectionName` is portable.
 */
export type DetectedMetadataFile = Pick<
  BatchUploadMetadata,
  'modelName' | 'description' | 'artist' | 'tags' | 'metadata' | 'newCollectionName'
>;

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
  archives?: DetectedArchiveFile[];
  /** Parsed root-level metadata.json, when the archive carried one. */
  metadataFile?: DetectedMetadataFile;
}

/**
 * A staged import session — one uploaded archive awaiting review/commit.
 */
export interface ImportSession {
  id: string;
  originalFilename: string;
  status: ImportSessionStatus;
  detected: DetectedImportMetadata | null;
  /** User/assistant-reviewed metadata staged for a later explicit commit. */
  draftMetadata: BatchUploadMetadata | null;
  /** User-reviewed destination layout staged independently from metadata. */
  draftFileLayout: ImportFileLayoutPlan | null;
  modelId: string | null;
  commitProgress: ImportCommitProgress | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Response from initiating a scan (archive upload).
 */
export interface ScanUploadResponse {
  sessionId: string;
}

/** How an explicitly grouped set of uploaded archives should be extracted. */
export type MultipartArchiveMode = 'combine' | 'split';

/** Request body for POST /models/upload/multipart/complete. */
export interface CompleteMultipartUploadRequest {
  uploadIds: string[];
  mode: MultipartArchiveMode;
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
  /** Values for configured metadata fields, keyed by field slug. */
  metadata?: SetModelMetadataRequest;
  options?: UploadOptions;
}

/** Move every file below a source prefix while preserving its remaining path. */
export interface ImportFileLayoutPrefixMapping {
  /** Slash-separated source prefix. An empty string is the archive root fallback. */
  sourcePrefix: string;
  /** Destination folder below either Model or Images. */
  destinationPrefix: string;
}

/** Override one source file with an exact destination path. */
export interface ImportFileLayoutFileMapping {
  sourcePath: string;
  destinationPath: string;
}

/**
 * A compact staged-upload layout. Exact file mappings win over prefix mappings;
 * otherwise the longest matching source prefix wins.
 */
export interface ImportFileLayoutPlan {
  rootFolders: ['Model', 'Images'];
  prefixMappings: ImportFileLayoutPrefixMapping[];
  fileMappings?: ImportFileLayoutFileMapping[];
}
