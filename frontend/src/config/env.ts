/**
 * Derive the backend base URL from the page's own origin so the frontend
 * works on any hostname / IP with zero config changes.
 *
 * Rule: whatever host the browser used to reach the Vite dev-server
 * (localhost, 10.x.x.x, 192.168.x.x …) is also where the backend lives,
 * just on port 8000.
 *
 * VITE_API_BASE_URL still acts as an explicit override for non-standard
 * deployments (e.g. backend on a different host or behind a reverse proxy).
 */
const _inferredApiBase = (() => {
  // typeof window guard: safe in SSR / Vitest / node contexts
  if (typeof window === 'undefined') return 'http://127.0.0.1:8000';
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:8000`;
})();

const _apiBase: string = import.meta.env.VITE_API_BASE_URL ?? _inferredApiBase;

export const env = {
  apiBaseUrl: _apiBase,
  /**
   * BACKEND INTEGRATION:
   * Points at the /ws/execute streaming endpoint (see
   * artifacts/WEBSOCKET_STREAMING.md). Derived from apiBaseUrl by
   * swapping the scheme (http→ws / https→wss), so there is still only
   * one URL to configure.
   * Status: Available (backend), consumed by hooks/useStreamExecution.ts.
   */
  wsBaseUrl: _apiBase.replace(/^http/, 'ws'),
  /**
   * F1: Collaboration WebSocket base URL.
   * Derived from apiBaseUrl by swapping the scheme and appending /ws/collab —
   * matching the backend route /ws/collab/{room_id}.
   * Override with VITE_COLLABORATION_WS_URL for non-standard deployments.
   */
  collaborationWsBaseUrl: import.meta.env.VITE_COLLABORATION_WS_URL ??
    _apiBase.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws/collab',
} as const;