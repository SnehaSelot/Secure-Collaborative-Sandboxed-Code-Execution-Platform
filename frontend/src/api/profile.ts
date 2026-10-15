import { apiClient } from './client';

export interface UserProfile {
  user_id: string;
  email: string;
  display_name: string;
  roles: string[];
  created_at: string;
  profile_photo_url: string | null;
}

export async function getMyProfile(token: string) {
  const response = await apiClient.get<UserProfile>('/users/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.data;
}

export async function updateMyProfile(token: string, displayName: string) {
  const response = await apiClient.patch<UserProfile>('/users/me', { display_name: displayName }, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.data;
}

export async function uploadMyProfilePhoto(token: string, file: File) {
  const form = new FormData();
  form.append('photo', file);
  const response = await apiClient.post<UserProfile>('/users/me/photo', form, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'multipart/form-data' },
  });
  return response.data;
}

export async function fetchMyProfilePhoto(token: string, photoUrl?: string | null) {
  const response = await apiClient.get<Blob>(photoUrl || '/users/me/photo', {
    responseType: 'blob',
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.data;
}
