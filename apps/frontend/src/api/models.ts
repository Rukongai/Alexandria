import type {
  ApiResponse,
  ModelCard,
  ModelDetail,
  FileTreeNode,
  JobStatus,
  ModelSearchParams,
  UpdateModelRequest,
  UpdateModelFileRequest,
  UpdateModelFolderRequest,
  ImportConfig,
  ImportSession,
  BatchUploadMetadata,
  ScanUploadResponse,
  UploadInitResponse,
  MultipartArchiveMode,
  CompleteMultipartUploadRequest,
  MergeModelsResponse,
  ExtractArchiveResponse,
  SplitModelFolderRequest,
  SplitModelFolderResponse,
  CompressFolderResponse,
  ArchiveContents,
  MoveModelResponse,
} from '@alexandria/shared';
import { get, getBlob, post, postForLibrary, patch, del, putRaw, postForm } from './client';
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

export async function moveModel(id: string, targetLibraryId: string): Promise<MoveModelResponse> {
  const response = await post<MoveModelResponse>(`/models/${id}/move`, { targetLibraryId });
  return response.data;
}

export async function uploadModelFiles(
  id: string,
  files: File[],
  onProgress?: (pct: number) => void
): Promise<ModelDetail> {
  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file);
  }
  const response = await postForm<ModelDetail>(`/models/${id}/files/upload`, formData, onProgress);
  return response.data;
}

export async function createModelFolder(id: string, path: string): Promise<FileTreeNode[]> {
  const response = await post<FileTreeNode[]>(`/models/${id}/folders`, { path });
  return response.data;
}

export async function updateModelFile(
  id: string,
  fileId: string,
  data: UpdateModelFileRequest
): Promise<ModelDetail> {
  const response = await patch<ModelDetail>(`/models/${id}/files/${fileId}`, data);
  return response.data;
}

export async function deleteModelFile(id: string, fileId: string): Promise<ModelDetail> {
  const response = await del<ModelDetail>(`/models/${id}/files/${fileId}`);
  return response.data;
}

export async function deleteModelFiles(id: string, fileIds: string[]): Promise<ModelDetail> {
  const response = await post<ModelDetail>(`/models/${id}/files/delete`, { fileIds });
  return response.data;
}

export async function extractModelArchive(
  id: string,
  fileId: string,
): Promise<ExtractArchiveResponse> {
  const response = await post<ExtractArchiveResponse>(`/models/${id}/files/${fileId}/extract`);
  return response.data;
}

export async function getModelArchiveContents(
  id: string,
  fileId: string,
  signal?: AbortSignal,
): Promise<ArchiveContents> {
  const response = await get<ArchiveContents>(`/models/${id}/files/${fileId}/archive`, signal);
  return response.data;
}

export async function downloadModelArchiveEntry(
  id: string,
  fileId: string,
  path: string,
): Promise<Blob> {
  return getBlob(
    `/models/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}/archive/download?path=${encodeURIComponent(path)}`,
  );
}

export async function updateModelFolder(
  id: string,
  data: UpdateModelFolderRequest
): Promise<FileTreeNode[]> {
  const response = await patch<FileTreeNode[]>(`/models/${id}/folders`, data);
  return response.data;
}

export async function deleteModelFolder(id: string, path: string): Promise<ModelDetail> {
  const response = await post<ModelDetail>(`/models/${id}/folders/delete`, { path });
  return response.data;
}

export async function splitModelFolder(
  id: string,
  data: SplitModelFolderRequest,
): Promise<SplitModelFolderResponse> {
  const response = await post<SplitModelFolderResponse>(`/models/${id}/folders/split`, data);
  return response.data;
}

export async function compressModelFolder(
  id: string,
  path: string,
): Promise<CompressFolderResponse> {
  const response = await post<CompressFolderResponse>(`/models/${id}/folders/compress`, { path });
  return response.data;
}

export async function mergeModels(
  targetModelId: string,
  sourceModelIds: string[]
): Promise<MergeModelsResponse> {
  const response = await post<MergeModelsResponse>(`/models/${targetModelId}/merge`, {
    sourceModelIds,
  });
  return response.data;
}

export async function deleteModel(id: string): Promise<void> {
  await del(`/models/${id}`);
}

const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_CHUNK_RETRIES = 3;

async function uploadChunks(
  file: File,
  uploadId: string,
  onChunkProgress?: (uploadedBytes: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_CHUNK_RETRIES; attempt++) {
      signal?.throwIfAborted();
      try {
        await putRaw(
          `/models/upload/${uploadId}/chunk/${i}`,
          chunk,
          (chunkPct) => {
            const currentChunkBytes = chunk.size * (chunkPct / 100);
            onChunkProgress?.(start + currentChunkBytes);
          },
          signal,
        );
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (signal?.aborted) throw err;
        if (attempt < MAX_CHUNK_RETRIES - 1) {
          await abortableDelay(1000 * Math.pow(2, attempt), signal);
        }
      }
    }
    if (lastError) throw lastError;

    onChunkProgress?.(end);
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const handleAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new DOMException('Request aborted', 'AbortError'));
    };
    timeout = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', handleAbort, { once: true });
    if (signal.aborted) handleAbort();
  });
}

async function cleanUpUploads(uploadIds: string[]): Promise<void> {
  await Promise.allSettled(
    uploadIds.map((uploadId) => del(`/models/upload/${uploadId}`)),
  );
}

/**
 * Upload an archive file using chunked upload. Creates an import session
 * (status: scanning) instead of immediately creating a model.
 * Returns { sessionId } — poll the session to track scan progress.
 */
export async function scanUpload(
  file: File,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal,
  onFinalizing?: () => void,
  libraryId: string | null = null,
): Promise<ScanUploadResponse> {
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
  let uploadId: string | null = null;

  try {
    // 1. Initiate chunked upload session
    const initResponse = await post<UploadInitResponse>(
      '/models/upload/init',
      { filename: file.name, totalSize: file.size, totalChunks },
      signal,
    );
    uploadId = initResponse.data.uploadId;
    signal?.throwIfAborted();

    // 2. Upload chunks sequentially with per-chunk retry
    await uploadChunks(file, uploadId, (uploadedBytes) => {
      if (signal?.aborted) return;
      const ratio = file.size > 0 ? uploadedBytes / file.size : 1;
      onProgress?.(Math.round(ratio * 95));
    }, signal);

    if (!signal?.aborted) onProgress?.(95);

    // 3. Complete — assemble and start scan; returns { sessionId }
    signal?.throwIfAborted();
    onFinalizing?.();
    const completeResponse = await postForLibrary<ScanUploadResponse>(
      `/models/upload/${uploadId}/complete`,
      undefined,
      libraryId,
    );

    onProgress?.(100);

    return completeResponse.data;
  } catch (error) {
    if (uploadId) await cleanUpUploads([uploadId]);
    throw error;
  }
}

/**
 * Upload an explicit archive group and create one staged import session.
 * Every member uses the chunked protocol, regardless of its individual size.
 */
export async function scanMultipartUpload(
  files: File[],
  mode: MultipartArchiveMode,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal,
  onFinalizing?: () => void,
  libraryId: string | null = null,
): Promise<ScanUploadResponse> {
  if (files.length < 2 || files.length > 100) {
    throw new Error('Choose between 2 and 100 archive files.');
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes <= 0) {
    throw new Error('Archive files cannot be empty.');
  }

  const uploadIds: string[] = [];
  let completedBytes = 0;
  let reportedProgress = 0;
  onProgress?.(0);

  const reportProgress = (nextProgress: number) => {
    if (signal?.aborted) return;
    reportedProgress = Math.max(reportedProgress, nextProgress);
    onProgress?.(reportedProgress);
  };

  try {
    for (const file of files) {
      const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
      const initResponse = await post<UploadInitResponse>(
        '/models/upload/multipart/init',
        { filename: file.name, totalSize: file.size, totalChunks },
        signal,
      );
      const { uploadId } = initResponse.data;
      uploadIds.push(uploadId);
      signal?.throwIfAborted();

      await uploadChunks(file, uploadId, (fileUploadedBytes) => {
        const uploadedBytes = completedBytes + fileUploadedBytes;
        reportProgress(Math.round((uploadedBytes / totalBytes) * 95));
      }, signal);
      completedBytes += file.size;
    }

    reportProgress(95);
    signal?.throwIfAborted();
    onFinalizing?.();
    const completeResponse = await postForLibrary<ScanUploadResponse>(
      '/models/upload/multipart/complete',
      { uploadIds, mode } satisfies CompleteMultipartUploadRequest,
      libraryId,
    );
    reportProgress(100);

    return completeResponse.data;
  } catch (error) {
    await cleanUpUploads(uploadIds);
    throw error;
  }
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

export async function extractImportSessionArchive(
  id: string,
  relativePath: string,
): Promise<ImportSession> {
  const response = await post<ImportSession>(`/models/import-sessions/${id}/extract`, {
    relativePath,
  });
  return response.data;
}

export async function uploadImportSessionFiles(
  id: string,
  files: File[],
  onProgress?: (pct: number) => void,
): Promise<ImportSession> {
  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file);
  }
  const response = await postForm<ImportSession>(
    `/models/import-sessions/${id}/files`,
    formData,
    onProgress,
  );
  return response.data;
}

export async function importFolder(config: ImportConfig): Promise<{ modelId: string }> {
  const response = await post<{ modelId: string }>('/models/import', config);
  return response.data;
}
