import type {
  AiApplyProposalResponse,
  AiChatRequest,
  AiChatResponse,
  AiProvider,
  AiProviderModel,
  AiProviderTestResult,
  ApiResponse,
  CreateAiProviderRequest,
  UpdateAiProviderRequest,
} from '@alexandria/shared';
import { del, get, patch, post } from './client';

export function listAiProviders(): Promise<ApiResponse<AiProvider[]>> {
  return get<AiProvider[]>('/ai/providers');
}

export function createAiProvider(
  data: CreateAiProviderRequest,
): Promise<ApiResponse<AiProvider>> {
  return post<AiProvider>('/ai/providers', data);
}

export function updateAiProvider(
  id: string,
  data: UpdateAiProviderRequest,
): Promise<ApiResponse<AiProvider>> {
  return patch<AiProvider>(`/ai/providers/${id}`, data);
}

export function deleteAiProvider(id: string): Promise<ApiResponse<null>> {
  return del<null>(`/ai/providers/${id}`);
}

export function testAiProvider(id: string): Promise<ApiResponse<AiProviderTestResult>> {
  return post<AiProviderTestResult>(`/ai/providers/${id}/test`);
}

export function listAiProviderModels(id: string): Promise<ApiResponse<AiProviderModel[]>> {
  return get<AiProviderModel[]>(`/ai/providers/${id}/models`);
}

export function sendAiChat(
  data: AiChatRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<AiChatResponse>> {
  return post<AiChatResponse>('/ai/chat', data, signal);
}

export function applyAiProposal(id: string): Promise<ApiResponse<AiApplyProposalResponse>> {
  return post<AiApplyProposalResponse>(`/ai/proposals/${id}/apply`);
}
