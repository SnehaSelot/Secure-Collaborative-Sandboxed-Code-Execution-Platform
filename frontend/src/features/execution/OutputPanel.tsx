import { useRef, useEffect } from 'react';
import { useExecutionStore } from '../../state/executionStore';
import { ExecutionStatusBadge } from './ExecutionStatusBadge';

/**
 * Output panel that displays program execution results.
 * - Stdout and stderr from the executed code
 * - Execution status and metadata (exit code, runtime)
 * - Note: Interactive terminal input requires backend streaming support (not yet implemented)
 */
export function OutputPanel() {
  const isRunning = useExecutionStore((s) => s.isRunning);
  const result = useExecutionStore((s) => s.result);
  const error = useExecutionStore((s) => s.error);
  const terminalLines = useExecutionStore((s) => s.terminalLines);
  const addTerminalLine = useExecutionStore((s) => s.addTerminalLine);
  const clearTerminal = useExecutionStore((s) => s.clearTerminal);

  const terminalEndRef = useRef<HTMLDivElement>(null);

  // Clear terminal when execution starts
  useEffect(() => {
    if (isRunning) {
      clearTerminal();
    }
  }, [isRunning, clearTerminal]);

  // Auto-scroll to bottom when new lines are added
  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [terminalLines]);

  // When execution completes, add final output to terminal
  useEffect(() => {
    if (!isRunning && result && terminalLines.length === 0) {
      if (result.stdout) {
        addTerminalLine('output', result.stdout);
      }
      if (result.stderr) {
        addTerminalLine('error', result.stderr);
      }
    }
  }, [isRunning, result, terminalLines.length, addTerminalLine]);

  const badgeStatus = isRunning ? 'running' : (result?.status ?? (error ? 'error' : 'idle'));

  return (
    <div className="flex h-full flex-col rounded-lg border border-white/10 bg-neutral-900/60">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <span className="text-xs font-medium tracking-wide text-neutral-400 uppercase">
          Terminal / Output
        </span>
        <ExecutionStatusBadge status={badgeStatus} />
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Terminal output area */}
        <div className="flex-1 overflow-auto p-4 font-mono text-sm">
{/* Empty state message */}
        {terminalLines.length === 0 && !isRunning && !result && !error && (
          <div className="flex-1 p-4">
            <p className="text-sm text-neutral-600">Run your code to see output here.</p>
            <p className="mt-2 text-xs text-neutral-500">
              <strong>Note:</strong> Interactive terminal input requires backend streaming support, which is not yet implemented. 
              For now, pass input as command-line arguments or modify the backend to support streaming execution.
            </p>
          </div>
          )}

          {isRunning && terminalLines.length === 0 && (
            <div className="flex items-center gap-2 text-neutral-400">
              <svg
                className="h-4 w-4 animate-spin"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r="9"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeOpacity="0.3"
                />
                <path
                  d="M21 12a9 9 0 0 0-9-9"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
              </svg>
              Executing code in an isolated sandbox...
            </div>
          )}

          {/* Display terminal lines */}
          {terminalLines.map((line, idx) => (
            <div
              key={idx}
              className={
                line.type === 'input'
                  ? 'text-emerald-400'
                  : line.type === 'error'
                    ? 'text-red-300'
                    : line.type === 'info'
                      ? 'text-blue-400'
                      : 'text-neutral-200'
              }
            >
              {line.type === 'input' && <span className="text-neutral-500">› </span>}
              <pre className="inline whitespace-pre-wrap break-words">{line.text}</pre>
            </div>
          ))}

          {error && (
            <div className="mt-2 rounded-md border border-red-500/20 bg-red-500/5 p-3 text-red-300">
              {error}
            </div>
          )}

          {!isRunning && result && terminalLines.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-white/10 pt-3 text-xs text-neutral-500">
              <span>
                Exit code: <span className="text-neutral-300">{result.exit_code ?? 'n/a'}</span>
              </span>
              <span>
                Time: <span className="text-neutral-300">{result.execution_time.toFixed(2)}s</span>
              </span>
            </div>
          )}

          <div ref={terminalEndRef} />
        </div>

        {/* Input field disabled: requires backend streaming support */}
        {/* BACKEND INTEGRATION POINT: When /execute endpoint supports streaming responses
             (Server-Sent Events or WebSocket), replace this note with a live input field
             that sends stdin data to the running process in real-time. */}
        {!isRunning && (
          <div className="border-t border-white/10 bg-neutral-900/40 p-3">
            <p className="text-xs text-neutral-500">
              <span className="font-medium text-neutral-400">Live input not available:</span> Interactive stdin requires backend support for streaming execution. 
              This will be implemented in a future release.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}