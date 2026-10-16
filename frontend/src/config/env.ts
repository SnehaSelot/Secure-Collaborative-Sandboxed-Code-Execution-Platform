export const env = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8000',
  /**
   * BACKEND INTEGRATION:
   * Points at the /ws/execute streaming endpoint (see
   * artifacts/WEBSOCKET_STREAMING.md). Derived from apiBaseUrl by
   * swapping the scheme, so there's still only one URL to configure.
   * Status: Available (backend), consumed by hooks/useStreamExecution.ts.
   */
  wsBaseUrl: (import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8000').replace(
    /^http/,
    'ws',
  ),
  /**
   * F1: Collaboration WebSocket base URL.
   * Derived from apiBaseUrl by swapping the scheme (http→ws / https→wss)
   * and appending /ws/collab — matching the backend route /ws/collab/{room_id}.
   * Override with VITE_COLLABORATION_WS_URL for non-standard deployments.
   * Default: ws://localhost:8000/ws/collab
   */
  collaborationWsBaseUrl: import.meta.env.VITE_COLLABORATION_WS_URL ??
    (import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8000')
      .replace(/^http/, 'ws')
      .replace(/\/$/, '') + '/ws/collab',
} as const;