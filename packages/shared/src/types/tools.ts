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

export interface DuplicateScanResult {
  scannedModelCount: number;
  redundantModelCount: number;
  reclaimableBytes: number;
  groups: DuplicateGroup[];
}
