import type { UserProfile, UpdateProfileRequest } from '@alexandria/shared';
import { get, post, patch } from './client';

export async function login(email: string, password: string): Promise<UserProfile> {
  const response = await post<UserProfile>('/auth/login', { email, password });
  return response.data;
}

export async function logout(): Promise<void> {
  await post<null>('/auth/logout');
}

export async function getMe(): Promise<UserProfile> {
  const response = await get<UserProfile>('/auth/me');
  return response.data;
}

export async function updateProfile(data: UpdateProfileRequest): Promise<UserProfile> {
  const response = await patch<UserProfile>('/auth/me', data);
  return response.data;
}
