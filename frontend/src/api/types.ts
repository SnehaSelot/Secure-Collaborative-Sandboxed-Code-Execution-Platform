/**
 * Types for the currently LIVE backend contract, transcribed directly
 * from BACKEND_API.md — not guessed, not extended with fields the
 * backend doesn't actually return.
 */

/** BACKEND INTEGRATION: GET /health response shape. Status: Available. */
export interface HealthResponse {
  status: 'ok';
}

/** BACKEND INTEGRATION: GET /languages response shape. Status: Available. */
export interface LanguagesResponse {
  languages: string[];
}

/** BACKEND INTEGRATION: GET /limits response shape. Status: Available. */
export interface LimitsResponse {
  timeout_seconds: number;
  memory_limit: string;
  max_processes: number;
  max_open_files: number;
  max_file_size_bytes: number;
  max_output_chars: number;
}

/** BACKEND INTEGRATION: POST /execute request shape. Status: Available. */
export interface ExecuteRequest {
  language: string;
  code: string;
}

export type ExecutionStatus = 'success' | 'error' | 'timeout' | 'internal_error';

/** BACKEND INTEGRATION: POST /execute response shape. Status: Available. */
export interface ExecuteResponse {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  status: ExecutionStatus;
  execution_time: number;
}

/**
 * Shape of FastAPI's error responses (400 / 422 / 500), per BACKEND_API.md.
 * 422 returns an array under `detail`; 400/500 return a string. Both are
 * covered so client.ts can normalize either into a plain message.
 */
export interface ApiErrorDetailItem {
  type: string;
  loc: (string | number)[];
  msg: string;
}

export interface ApiErrorResponse {
  detail: string | ApiErrorDetailItem[];
}