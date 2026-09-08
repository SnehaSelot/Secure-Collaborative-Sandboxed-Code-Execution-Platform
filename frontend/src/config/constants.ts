/**
 * App-wide constants that are not secrets and not per-environment,
 * so they live here instead of in .env.
 */

/**
 * BACKEND INTEGRATION:
 * Endpoint: GET /languages
 * Status: Available
 * This list is ONLY a fallback for when that request fails (backend down,
 * network error). If the request succeeds, the real list from the
 * backend is used instead — see useLanguages.ts. Kept in sync with
 * executor.py's LANGUAGE_IMAGES keys as of the last backend review.
 */
export const FALLBACK_LANGUAGES = [
  'c',
  'cpp',
  'go',
  'java',
  'javascript',
  'python',
  'rust',
] as const;

export const DEFAULT_LANGUAGE = 'python';

export const DEFAULT_CODE = 'print("Hello from GlassHouse!")';

/**
 * Docker image pulls on a language's first run can take minutes
 * (see test_execution_service.py's own comment on this). This timeout
 * must comfortably exceed that, or a slow-but-successful first run
 * looks like a network failure to the user.
 */
export const EXECUTE_TIMEOUT_MS = 120_000;

/** How often the header polls GET /health to show live connection status. */
export const HEALTH_POLL_INTERVAL_MS = 15_000;