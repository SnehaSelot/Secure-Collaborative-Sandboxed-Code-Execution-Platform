import { env } from '../config/env';
import type { ExecutionStatus } from './types';

/**
 * BACKEND INTEGRATION:
 * Endpoint: WS /ws/execute (see artifacts/WEBSOCKET_STREAMING.md)
 * Status: Available
 *
 * Current protocol is ONE-SHOT and one-directional after the initial
 * message:
 *   client → { language, code }                          (sent once, on open)
 *   server → stdout / stderr / *_truncated / result / error
 * There is no message type for the client to send anything else while
 * execution is running — this is why stdin is not implemented anywhere
 * in this file. Do not send extra client→server messages against the
 * current backend; it doesn't expect or read them.
 *
 * Kept isolated the same way api/execution.ts is, so useStreamExecution.ts
 * (and anything else) never touches raw WebSocket/JSON framing directly.
 */

export interface StreamResult {
  exit_code: number | null;
  status: ExecutionStatus;
  execution_time: number;
}

export interface StreamCallbacks {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onStdoutTruncated?: () => void;
  onStderrTruncated?: () => void;
  onResult?: (result: StreamResult) => void;
  onError?: (message: string) => void;
}

/** Returns a cancel function; calling it closes the socket early. */
export function streamExecute(
  language: string,
  code: string,
  callbacks: StreamCallbacks,
): () => void {
  const { onStdout, onStderr, onStdoutTruncated, onStderrTruncated, onResult, onError } =
    callbacks;

  const ws = new WebSocket(`${env.wsBaseUrl}/ws/execute`);

  ws.onopen = () => {
    // Only message the client ever sends, per the documented protocol.
    ws.send(JSON.stringify({ language, code }));

    // TODO(stdin, backend work required first): once /ws/execute supports
    // a running program reading from stdin, the protocol needs a new
    // client→server message type sent WHILE isRunning is true — e.g.
    // { type: "stdin", data: "<text>\n" } — forwarded by the backend to
    // the Docker container's stdin stream. That requires:
    //   1. Backend: keep the WS connection open for writes after the
    //      initial message, and pipe incoming "stdin" messages into the
    //      sandboxed process's stdin (backend/app/services/executor.py).
    //   2. Frontend: this function would need to return not just a
    //      cancel callback but also a `sendInput(text: string)` function
    //      (call `ws.send(...)` on the same socket instance above),
    //      which useStreamExecution.ts exposes to the Terminal component
    //      so a line the user types while isRunning can be forwarded
    //      immediately instead of queued.
    // Do not implement this until the backend actually supports it —
    // sending it today would be ignored by the server.
  };

  ws.onmessage = (event) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(event.data);
    } catch {
      onError?.('Received malformed message from server.');
      return;
    }

    switch (msg.type) {
      case 'stdout':
        onStdout?.(String(msg.data ?? ''));
        break;
      case 'stderr':
        onStderr?.(String(msg.data ?? ''));
        break;
      case 'stdout_truncated':
        onStdoutTruncated?.();
        break;
      case 'stderr_truncated':
        onStderrTruncated?.();
        break;
      case 'result':
        onResult?.(msg as unknown as StreamResult);
        break;
      case 'error':
        onError?.(String(msg.message ?? 'Execution error.'));
        break;
    }
  };

  ws.onerror = () => {
    onError?.('Could not reach the backend at ' + env.wsBaseUrl + '.');
  };

  return () => ws.close();
}