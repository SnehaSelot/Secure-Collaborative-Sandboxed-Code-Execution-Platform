export const env = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000',
  /**
   * BACKEND INTEGRATION:
   * Points at the /ws/execute streaming endpoint (see
   * artifacts/WEBSOCKET_STREAMING.md). Derived from apiBaseUrl by
   * swapping the scheme, so there's still only one URL to configure.
   * Status: Available (backend), consumed by hooks/useStreamExecution.ts.
   */
  wsBaseUrl: (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000').replace(
    /^http/,
    'ws',
  ),
} as const;