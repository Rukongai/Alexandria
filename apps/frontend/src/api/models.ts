import type {
  ApiResponse,
  ModelCard,
  ModelDetail,
  FileTreeNode,
  JobStatus,
  ModelSearchParams,
  UpdateModelRequest,
  ImportConfig,
  ImportSession,
  BatchUploadMetadata,
  ScanUploadResponse,
} from '@alexandria/shared';
import { get, post, patch, del, putRaw } from './client';
import { buildQueryString } from '../lib/query';

export async function getModels(params: ModelSearchParams): Promise<ApiResponse<ModelCard[]>> {
  const { metadataFilters, ...rest } = params;
  const flat: Record<string, unknown> = { ...rest };

  if (metadataFilters) {
    for (const [key, value] of Object.entries(metadataFilters)) {
      flat[`meta_${key}`] = value;
    }
  }

  const qs = buildQueryString(flat);
  return get<ModelCard[]>(`/models${qs}`);
}

export async function getModel(id: string): Promise<ModelDetail> {
  const response = await get<ModelDetail>(`/models/${id}`);
  return response.data;
}

export async function getModelFiles(id: string): Promise<FileTreeNode[]> {
  const response = await get<FileTreeNode[]>(`/models/${id}/files`);
  return response.data;
}

export async function getModelStatus(id: string): Promise<JobStatus> {
  const response = await get<JobStatus>(`/models/${id}/status`);
  return response.data;
}

export async function updateModel(id: string, data: UpdateModelRequest): Promise<ModelDetail> {
  const response = await patch<ModelDetail>(`/models/${id}`, data);
  return response.data;
}

export async function deleteModel(id: string): Promise<void> {
  await del(`/models/${id}`);
}

const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_CHUNK_RETRIES = 3;

/**
 * Upload an archive file using chunked upload. Creates an import session
 * (status: scanning) instead of immediately creating a model.
 * Returns { sessionId } — poll the session to track scan progress.
 */
export async function scanUpload(
  file: File,
  onProgress?: (pct: number) => void
): Promise<ScanUploadResponse> {
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));

  // 1. Initiate chunked upload session
  const initResponse = await post<{ uploadId: string; expiresAt: string }>(
    '/models/upload/init',
    { filename: file.name, totalSize: file.size, totalChunks },
  );
  const { uploadId } = initResponse.data;

  // 2. Upload chunks sequentially with per-chunk retry
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_CHUNK_RETRIES; attempt++) {
      try {
        await putRaw(
          `/models/upload/${uploadId}/chunk/${i}`,
          chunk,
          (chunkPct) => {
            if (onProgress) {
              const chunkFraction = chunkPct / 100;
              const overallPct = Math.round(((i + chunkFraction) / totalChunks) * 95);
              onProgress(overallPct);
            }
          },
        );
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (attempt < MAX_CHUNK_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
      }
    }
    if (lastError) throw lastError;
  }

  onProgress?.(95);

  // 3. Complete — assemble and start scan; returns { sessionId }
  const completeResponse = await post<ScanUploadResponse>(
    `/models/upload/${uploadId}/complete`,
  );

  onProgress?.(100);

  return completeResponse.data;
}

export async function listImportSessions(): Promise<ImportSession[]> {
  const response = await get<ImportSession[]>('/models/import-sessions');
  return response.data;
}

export async function getImportSession(id: string): Promise<ImportSession> {
  const response = await get<ImportSession>(`/models/import-sessions/${id}`);
  return response.data;
}

export async function commitImportSession(
  id: string,
  batchMetadata?: BatchUploadMetadata
): Promise<{ modelId: string; jobId: string }> {
  const response = await post<{ modelId: string; jobId: string }>(
    `/models/import-sessions/${id}/commit`,
    batchMetadata ? { batchMetadata } : undefined
  );
  return response.data;
}

export async function discardImportSession(id: string): Promise<void> {
  await del(`/models/import-sessions/${id}`);
}

export async function importFolder(config: ImportConfig): Promise<{ modelId: string }> {
  const response = await post<{ modelId: string }>('/models/import', config);
  return response.data;
}
