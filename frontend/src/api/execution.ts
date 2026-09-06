import { apiClient } from './client';
import type {
  HealthResponse,
  LanguagesResponse,
  LimitsResponse,
  ExecuteRequest,
  ExecuteResponse,
} from './types';

/**
 * BACKEND INTEGRATION:
 * Endpoint: GET /health
 * Status: Available
 * Request: None
 * Response: { status: string }
 * TODO: Keep this function isolated so the endpoint can be changed later.
 */
export async function getHealth(): Promise<HealthResponse> {
  const { data } = await apiClient.get<HealthResponse>('/health');
  return data;
}

/**
 * BACKEND INTEGRATION:
 * Endpoint: GET /languages
 * Status: Available
 * Request: None
 * Response: { languages: string[] }
 * TODO: Keep this function isolated so the endpoint can be changed later.
 */
export async function getLanguages(): Promise<LanguagesResponse> {
  const { data } = await apiClient.get<LanguagesResponse>('/languages');
  return data;
}

/**
 * BACKEND INTEGRATION:
 * Endpoint: GET /limits
 * Status: Available
 * Request: None
 * Response: { timeout_seconds, memory_limit, max_processes, max_open_files,
 *              max_file_size_bytes, max_output_chars }
 * TODO: Keep this function isolated so the endpoint can be changed later.
 */
export async function getLimits(): Promise<LimitsResponse> {
  const { data } = await apiClient.get<LimitsResponse>('/limits');
  return data;
}

/**
 * BACKEND INTEGRATION:
 * Endpoint: POST /execute
 * Status: Available
 * Request: { language: string, code: string }
 * Response: { stdout, stderr, exit_code, status, execution_time }
 * TODO: Backend is synchronous today (blocks until the container exits).
 * When streaming execution ships, replace this single request in
 * useExecuteCode.ts with a WebSocket/SSE subscription — OutputPanel.tsx
 * and ExecutionStatusBadge.tsx are written against the executionStore
 * shape, not against this function directly, so they won't need changes.
 */
export async function executeCode(request: ExecuteRequest): Promise<ExecuteResponse> {
  const { data } = await apiClient.post<ExecuteResponse>('/execute', request);
  return data;
}