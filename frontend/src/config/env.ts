/**
 * Central environment configuration.
 *
 * Every other file that needs a backend URL imports from HERE, not from
 * `import.meta.env` directly. That way, when new backend services exist
 * (collab-gateway, auth, etc.) we add one new field in one place.
 */

export const env = {
  /**
   * BACKEND INTEGRATION:
   * Points at Arya's FastAPI execution service (main.py), which currently
   * serves GET /health, GET /languages, GET /limits, POST /execute.
   * Status: Available.
   */
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000',
} as const;