import { env } from './env';

/**
 * Returns the Yjs room name for a given file.
 * In solo (no-session) mode the room name is just the fileId.
 * In collaboration mode the room is "{sessionId}:{fileId}".
 */
export function getFileRoomName(fileId: string): string {
  return fileId;
}

/**
 * Builds a collab session room name from a session ID and a file ID.
 * This matches the backend format "{session_id}:{file_id}".
 */
export function getSessionFileRoomName(sessionId: string, fileId: string): string {
  return `${sessionId}:${fileId}`;
}

/**
 * Returns the WebSocket base URL for y-websocket's WebsocketProvider.
 * y-websocket will append "/{roomName}" to this base URL automatically.
 *
 * Falls back to env.collaborationWsBaseUrl (which defaults to
 * ws://localhost:8000/ws/collab — no new .env var needed for dev).
 *
 * For non-standard deployments, set VITE_COLLABORATION_WS_URL.
 */
export function getCollaborationWsBaseUrl(
  override?: string | null,
): string | null {
  const base = override !== undefined ? override : env.collaborationWsBaseUrl;
  if (!base) return null;

  const url = new URL(base);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('The collaboration URL must use ws:// or wss://.');
  }
  return base;
}

/**
 * F1: Builds the full WebSocket URL for a specific room.
 * Used when calling the WS endpoint directly (e.g. diagnostic tools or tests).
 * For y-websocket's WebsocketProvider, use getCollaborationWsBaseUrl() + room name separately.
 *
 * @param fileId - the room name (fileId or "{sessionId}:{fileId}")
 * @param baseUrl - the WS base URL (default: env.collaborationWsBaseUrl)
 * @param token - optional JWT to append as ?token=
 */
export function getCollaborationSocketUrl(
  fileId: string,
  baseUrl: string | null = env.collaborationWsBaseUrl,
  token?: string,
): string | null {
  if (!baseUrl) return null;

  const url = new URL(baseUrl);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('The collaboration URL must use ws:// or wss://.');
  }

  url.pathname = `${url.pathname.replace(/\/+$/, '')}/collab/${encodeURIComponent(fileId)}`;
  if (token) {
    url.searchParams.set('token', token);
  }
  return url.toString();
}
