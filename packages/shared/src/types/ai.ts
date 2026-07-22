import type { SetModelMetadataRequest } from './metadata.js';
import type { UpdateModelRequest } from './model.js';

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
    modelId?: string;
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

export type AiChange =
  | AiUpdateModelChange
  | AiSetMetadataChange
  | AiUpdateCollectionsChange;

export interface AiChangePreviewDisplay {
  collections: Record<string, { name: string }>;
  images: Record<string, { filename: string; thumbnailUrl: string | null }>;
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
}
