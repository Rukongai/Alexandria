import type { SetModelMetadataRequest } from './metadata.js';
import type { UpdateModelRequest } from './model.js';
import type { BatchUploadMetadata } from './upload.js';
import type { BulkMetadataOperation } from './api.js';

export interface AiProvider {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  isDefault: boolean;
  hasApiKey: boolean;
  apiKeyHint: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAiProviderRequest {
  name: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  isDefault?: boolean;
}

export interface UpdateAiProviderRequest {
  name?: string;
  baseUrl?: string;
  apiKey?: string | null;
  model?: string;
  isDefault?: boolean;
}

export interface AiProviderModel {
  id: string;
  ownedBy: string | null;
}

export interface AiProviderTestResult {
  ok: true;
  modelCount: number;
}

export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiChatRequest {
  message: string;
  history?: AiChatMessage[];
  providerId?: string;
  context?: {
    /** Backward-compatible single-model target. */
    modelId?: string;
    /** Current detail/selection/page model targets. */
    modelIds?: string[];
    /** Current staged-upload targets. */
    importSessionIds?: string[];
  };
}

export interface AiSource {
  title: string;
  url: string;
  snippet?: string;
  imageUrl?: string;
}

export interface AiUpdateModelChange {
  type: 'update_model';
  modelId: string;
  modelName: string;
  patch: Pick<UpdateModelRequest, 'name' | 'description' | 'previewImageFileId'>;
}

export interface AiSetMetadataChange {
  type: 'set_metadata';
  modelId: string;
  modelName: string;
  values: SetModelMetadataRequest;
}

export interface AiUpdateCollectionsChange {
  type: 'update_collections';
  modelId: string;
  modelName: string;
  addCollectionIds: string[];
  removeCollectionIds: string[];
}

export interface AiUpdateImportSessionChange {
  type: 'update_import_session';
  importSessionId: string;
  /** Identity guard captured when the proposal is previewed. */
  originalFilename: string;
  /** Optimistic stale-state guard captured from the staged session. */
  expectedUpdatedAt: string;
  /** Non-empty draft patch. Nested metadata/options are merged on apply. */
  patch: BatchUploadMetadata;
}

export interface AiBulkMetadataChange {
  type: 'bulk_metadata';
  /** Frozen, ownership-validated model IDs resolved when the preview is created. */
  modelIds: string[];
  operations: BulkMetadataOperation[];
}

export interface AiBulkCollectionOperation {
  collectionId: string;
  action: 'add' | 'remove';
}

export interface AiBulkCollectionsChange {
  type: 'bulk_collections';
  /** Frozen, ownership-validated model IDs resolved when the preview is created. */
  modelIds: string[];
  operations: AiBulkCollectionOperation[];
}

export type AiChange =
  | AiUpdateModelChange
  | AiSetMetadataChange
  | AiUpdateCollectionsChange
  | AiUpdateImportSessionChange
  | AiBulkMetadataChange
  | AiBulkCollectionsChange;

export interface AiChangePreviewDisplay {
  collections: Record<string, { name: string }>;
  images: Record<string, { filename: string; thumbnailUrl: string | null }>;
  bulkTarget?: {
    scope: 'current_models' | 'active_library';
    modelCount: number;
    sampleModelNames: string[];
  };
}

export interface AiChangePreview {
  proposalId: string;
  summary: string;
  changes: AiChange[];
  expiresAt: string;
  /** Server-resolved labels and image assets for human-readable review. */
  display?: AiChangePreviewDisplay;
}

export interface AiChatResponse {
  message: string;
  sources: AiSource[];
  proposal: AiChangePreview | null;
}

export interface AiApplyProposalResponse {
  proposalId: string;
  status: 'applied';
  changedModelIds: string[];
  changedImportSessionIds: string[];
}
