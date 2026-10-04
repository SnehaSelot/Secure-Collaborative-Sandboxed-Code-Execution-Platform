import { env } from './env';

export function getFileRoomName(fileId: string): string {
  return fileId;
}

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
