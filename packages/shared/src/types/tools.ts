export interface DuplicateModel {
  id: string;
  name: string;
  originalFilename: string | null;
  createdAt: string;
}

export interface DuplicateGroup {
  fingerprint: string;
  fileCount: number;
  totalSizeBytes: number;
  reclaimableBytes: number;
  models: DuplicateModel[];
}

export interface DuplicateFile {
  id: string;
  modelId: string;
  modelName: string;
  filename: string;
  relativePath: string;
  sizeBytes: number;
  createdAt: string;
}

export interface DuplicateFileGroup {
  hash: string;
  sizeBytes: number;
  reclaimableBytes: number;
  files: DuplicateFile[];
}

/** A duplicate archive member reported for information only. */
export interface DuplicateArchiveFile {
  id: string;
  modelId: string;
  modelName: string;
  filename: string;
  relativePath: string;
  archiveFileId: string;
  archiveFilename: string;
  archiveRelativePath: string;
  sizeBytes: number;
  createdAt: string;
}

export interface DuplicateArchiveFileGroup {
  hash: string;
  sizeBytes: number;
  reclaimableBytes: number;
  files: DuplicateArchiveFile[];
}

export interface DuplicateScanResult {
  scannedModelCount: number;
  scannedFileCount: number;
  scannedArchiveFileCount: number;
  scannedArchiveEntryCount: number;
  redundantModelCount: number;
  redundantFileCount: number;
  reclaimableBytes: number;
  fileReclaimableBytes: number;
  groups: DuplicateGroup[];
  fileGroups: DuplicateFileGroup[];
  archiveFileGroups: DuplicateArchiveFileGroup[];
}

export interface MarkDuplicatesResult {
  markedFileCount: number;
  markedModelCount: number;
}

export interface IgnoreDuplicatesResult {
  ignoredFileGroupCount: number;
  ignoredModelGroupCount: number;
}

/** One physical object removed while consolidating an exact duplicate model. */
export interface ConsolidatedDuplicateFile {
  id: string;
  filename: string;
  relativePath: string;
  sizeBytes: number;
  hash: string;
}

/** A generated rendition removed with one of the source files. */
export interface ConsolidatedDuplicateThumbnail {
  id: string;
  sourceFileId: string;
  sourceFilename: string;
  width: number;
  height: number;
  format: string;
}

/** A source metadata value copied because the target did not have that field. */
export interface ConsolidatedDuplicateMetadata {
  fieldDefinitionId: string;
  fieldName: string;
  fieldSlug: string;
  value: string;
}

export interface ConsolidatedDuplicateCollection {
  id: string;
  name: string;
}

export interface ConsolidatedDuplicateTag {
  id: string;
  name: string;
}

export interface ConsolidatedDuplicateModel {
  id: string;
  name: string;
}

/**
 * The complete, per-model effect of consolidating one exact duplicate into a
 * retained model. The preview and confirmed result intentionally have the
 * same shape so the confirmation dialog can display every action up front.
 */
export interface ConsolidateDuplicateModelsResult {
  sourceModel: ConsolidatedDuplicateModel;
  targetModel: ConsolidatedDuplicateModel;
  removedFiles: ConsolidatedDuplicateFile[];
  removedThumbnails: ConsolidatedDuplicateThumbnail[];
  copiedMetadata: ConsolidatedDuplicateMetadata[];
  addedCollections: ConsolidatedDuplicateCollection[];
  addedTags: ConsolidatedDuplicateTag[];
  /** Compatibility summary for copiedMetadata.length. */
  copiedMetadataFieldCount: number;
  /** Compatibility summary for addedCollections.length. */
  addedCollectionCount: number;
  /** Compatibility summary for addedTags.length. */
  addedTagCount: number;
  deletedFileCount: number;
  reclaimableBytes: number;
  deletedSourceModelId: string;
}

export type ConsolidateDuplicateModelsPreview = ConsolidateDuplicateModelsResult;
