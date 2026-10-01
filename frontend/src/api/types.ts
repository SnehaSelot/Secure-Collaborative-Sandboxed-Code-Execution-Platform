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
  max_stdin_chars?: number;
}

/** BACKEND INTEGRATION: POST /execute request shape. Status: Available. */
export interface ExecuteRequest {
  language: string;
  code: string;
  /** Optional — only sent when non-empty. Piped to the program's stdin. */
  stdin?: string;
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

// ---------------------------------------------------------------------------
// WebSocket /ws/execute — server → client message types
// ---------------------------------------------------------------------------

/** Initial message shape sent by the client to /ws/execute. */
export interface WsExecuteRequest {
  language: string;
  code: string;
  stdin?: string;
}

/** A chunk of stdout from the running container. */
export interface WsStdoutMessage {
  type: 'stdout';
  data: string;
}

/** A chunk of stderr from the running container. */
export interface WsStderrMessage {
  type: 'stderr';
  data: string;
}

/** Emitted once when the stdout output limit is reached. */
export interface WsStdoutTruncatedMessage {
  type: 'stdout_truncated';
}

/** Emitted once when the stderr output limit is reached. */
export interface WsStderrTruncatedMessage {
  type: 'stderr_truncated';
}

/** Validation or setup error (sent before the container starts). */
export interface WsErrorMessage {
  type: 'error';
  message: string;
}

/**
 * Final message — always the last one sent on a connection.
 * status is overridden to 'timeout' by the server when a kill was issued.
 */
export interface WsResultMessage {
  type: 'result';
  exit_code: number | null;
  status: ExecutionStatus;
  execution_time: number;
}

/** Discriminated union of every message the server can send over /ws/execute. */
export type WsServerMessage =
  | WsStdoutMessage
  | WsStderrMessage
  | WsStdoutTruncatedMessage
  | WsStderrTruncatedMessage
  | WsErrorMessage
  | WsResultMessage;