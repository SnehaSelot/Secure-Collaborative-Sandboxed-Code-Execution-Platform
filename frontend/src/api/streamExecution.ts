import { env } from '../config/env';
import type { ExecutionStatus } from './types';

/**
 * BACKEND INTEGRATION:
 * Endpoint: WS /ws/execute (see artifacts/WEBSOCKET_STREAMING.md)
 * Status: Available
 *
 * Protocol:
 *   client → { language, code, stdin }   (sent once, on open)
 *   server → stdout / stderr / *_truncated / result / error
 *
 * stdin update: the backend now accepts stdin, but it is written to the
 * container right after it starts and the socket is closed (EOF) —
 * there is still no channel to send anything else once execution is
 * running. True mid-run interactive stdin (a "stdin" message type sent
 * WHILE isRunning is true, forwarded live to the process) is not
 * supported — that still needs the backend/protocol work described
 * below if it's ever wanted.
 *
 * TODO(live stdin, backend work required first): a client→server
 * message type sent while running — e.g. { type: "stdin", data: "..." }
 * — forwarded by the backend to the already-running container's stdin.
 * Today's backend pre-attaches and closes stdin before streaming starts
 * (see backend/app/services/executor.py's stream_run_code /
 * _send_stdin_and_close), so this would need real backend changes, not
 * just a frontend one.
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
  stdin: string,
  callbacks: StreamCallbacks,
): () => void {
  const { onStdout, onStderr, onStdoutTruncated, onStderrTruncated, onResult, onError } =
    callbacks;

  const ws = new WebSocket(`${env.wsBaseUrl}/ws/execute`);

  ws.onopen = () => {
    // Only message the client ever sends, per the documented protocol.
    ws.send(JSON.stringify({ language, code, stdin }));
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