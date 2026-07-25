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

export interface DuplicateScanResult {
  scannedModelCount: number;
  scannedFileCount: number;
  redundantModelCount: number;
  redundantFileCount: number;
  reclaimableBytes: number;
  fileReclaimableBytes: number;
  groups: DuplicateGroup[];
  fileGroups: DuplicateFileGroup[];
}
