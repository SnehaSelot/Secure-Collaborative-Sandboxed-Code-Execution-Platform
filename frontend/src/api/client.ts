import axios, { AxiosError } from 'axios';
import type { ApiErrorResponse } from './types';
import { env } from '../config/env';
import { EXECUTE_TIMEOUT_MS } from '../config/constants';

/**
 * Single axios instance for the whole app. Every request goes through
 * here so the base URL and timeout only need to change in one place
 * when new backend services (auth, collab, etc.) come online.
 *
 * Timeout is set to EXECUTE_TIMEOUT_MS (120s) globally rather than
 * per-request: /execute is the only slow call today, and a 120s
 * ceiling on /health, /languages, /limits is harmless — those return
 * almost instantly when the backend is up, and we don't want a
 * separate low-timeout client just for three fast endpoints.
 */
export const apiClient = axios.create({
  baseURL: env.apiBaseUrl,
  timeout: EXECUTE_TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/json',
  },
});

/**
 * Normalizes FastAPI's error shapes (400/422/500 per BACKEND_API.md) plus
 * network-level failures (backend unreachable, timeout) into one plain
 * message string the UI can render without knowing about axios internals.
 */
export function extractErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError<ApiErrorResponse>;

    if (axiosError.code === 'ECONNABORTED') {
      return 'The request timed out. The backend may be pulling a Docker image for this language for the first time — try again in a moment.';
    }

    if (!axiosError.response) {
      return 'Could not reach the backend. Is it running at ' + env.apiBaseUrl + '?';
    }

    const detail = axiosError.response.data?.detail;

    if (typeof detail === 'string') {
      return detail;
    }

    if (Array.isArray(detail) && detail.length > 0) {
      return detail.map((item) => item.msg).join('; ');
    }

    return `Request failed with status ${axiosError.response.status}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'An unknown error occurred.';
}