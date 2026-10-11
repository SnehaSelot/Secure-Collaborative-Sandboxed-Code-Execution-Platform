/**
 * api/collaborationApi.ts — REST client for collaboration session and file endpoints.
 *
 * F5: Integrates the existing backend session file APIs:
 *   POST   /sessions/{session_id}/files
 *   GET    /sessions/{session_id}/files
 *   GET    /sessions/{session_id}/files/{file_id}
 *   PATCH  /sessions/{session_id}/files/{file_id}
 *   DELETE /sessions/{session_id}/files/{file_id}
 *
 * Also integrates session lifecycle:
 *   POST   /sessions              — create session
 *   GET    /sessions/{session_id} — get session info
 *   POST   /sessions/{session_id}/join
 *
 * All requests use Bearer token authentication from authStore.
 * Respects existing authentication, ownership, participant permissions,
 * path validation, and API error responses.
 */

import { apiClient } from './client';

// ---------------------------------------------------------------------------
// Types (matching backend Pydantic models)
// ---------------------------------------------------------------------------

export interface SessionResponse {
  session_id: string;
  owner_id: string;
  name: string;
  status: 'active' | 'hibernated' | 'closed' | string;
}

export interface FileItemResponse {
  id: string;
  session_id: string;
  path: string;
  language: string | null;
  updated_at: string;
  /** Populated by the detail endpoint when a file is opened. */
  content?: string | null;
}

export interface FileDetailResponse {
  id: string;
  session_id: string;
  path: string;
  language: string | null;
  content: string | null;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Session endpoints
// ---------------------------------------------------------------------------

/** Create a new collaboration session. Caller becomes the owner. */
export async function createCollabSession(
  name: string,
  token: string,
): Promise<SessionResponse> {
  const response = await apiClient.post<SessionResponse>(
    '/sessions',
    { name },
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return response.data;
}

/** Get session info. Caller must be owner or participant. */
export async function getCollabSession(
  sessionId: string,
  token: string,
): Promise<SessionResponse> {
  const response = await apiClient.get<SessionResponse>(
    `/sessions/${encodeURIComponent(sessionId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return response.data;
}

/** Join a session as participant (idempotent). */
export async function joinCollabSession(
  sessionId: string,
  token: string,
): Promise<void> {
  await apiClient.post(
    `/sessions/${encodeURIComponent(sessionId)}/join`,
    {},
    { headers: { Authorization: `Bearer ${token}` } },
  );
}

/** Leave a session. */
export async function leaveCollabSession(
  sessionId: string,
  token: string,
): Promise<void> {
  await apiClient.post(
    `/sessions/${encodeURIComponent(sessionId)}/leave`,
    {},
    { headers: { Authorization: `Bearer ${token}` } },
  );
}

// ---------------------------------------------------------------------------
// File endpoints
// ---------------------------------------------------------------------------

/** Create a new file in a session. */
export async function createCollabFile(
  sessionId: string,
  path: string,
  language: string | null,
  content: string,
  token: string,
): Promise<FileItemResponse> {
  const response = await apiClient.post<FileItemResponse>(
    `/sessions/${encodeURIComponent(sessionId)}/files`,
    { path, language, content },
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return response.data;
}

/** List all files in a session (no content). */
export async function listCollabFiles(
  sessionId: string,
  token: string,
): Promise<FileItemResponse[]> {
  const response = await apiClient.get<FileItemResponse[]>(
    `/sessions/${encodeURIComponent(sessionId)}/files`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return response.data;
}

/** Get file detail including plain text content. */
export async function getCollabFile(
  sessionId: string,
  fileId: string,
  token: string,
): Promise<FileDetailResponse> {
  const response = await apiClient.get<FileDetailResponse>(
    `/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return response.data;
}

/** Rename a file path. */
export async function renameCollabFile(
  sessionId: string,
  fileId: string,
  newPath: string,
  token: string,
): Promise<FileItemResponse> {
  const response = await apiClient.patch<FileItemResponse>(
    `/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}`,
    { path: newPath },
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return response.data;
}

/** Delete a file (owner only). */
export async function deleteCollabFile(
  sessionId: string,
  fileId: string,
  token: string,
): Promise<void> {
  await apiClient.delete(
    `/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
}

