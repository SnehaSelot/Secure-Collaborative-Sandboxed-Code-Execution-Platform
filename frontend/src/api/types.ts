/**
 * Types for the currently LIVE backend contract, transcribed directly
 * from BACKEND_API.md — not guessed, not extended with fields the
 * backend doesn't actually return.
 */

export interface HealthResponse {
  status: 'ok';
}

export interface LanguagesResponse {
  languages: string[];
}

/**
 * BACKEND INTEGRATION: GET /limits response shape. Status: Available.
 * timeout_seconds is a per-language dict (not a single number) — see
 * backend/app/services/executor.py's TIMEOUT_SECONDS constant, e.g.
 * { python: 15, javascript: 15, java: 30, c: 20, cpp: 20, go: 60, rust: 60 }.
 * max_stdin_chars mirrors executor.py's MAX_STDIN_CHARS (65_536).
 */
export interface LimitsResponse {
  timeout_seconds: Record<string, number>;
  memory_limit: string;
  max_processes: number;
  max_open_files: number;
  max_file_size_bytes: number;
  max_output_chars: number;
  max_stdin_chars: number;
}

/** BACKEND INTEGRATION: POST /execute request shape. Status: Available.
 * stdin is sent upfront and closed (EOF) right after the container starts —
 * it's NOT live/interactive, so it can only be set before Run, not while
 * isRunning. See backend/app/services/executor.py's _send_stdin_and_close. */
export interface ExecuteRequest {
  language: string;
  code: string;
  stdin?: string;
}

export type ExecutionStatus = 'success' | 'error' | 'timeout' | 'internal_error';

export interface ExecuteResponse {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  status: ExecutionStatus;
  execution_time: number;
}

export interface ApiErrorDetailItem {
  type: string;
  loc: (string | number)[];
  msg: string;
}

export interface ApiErrorResponse {
  detail: string | ApiErrorDetailItem[];
}