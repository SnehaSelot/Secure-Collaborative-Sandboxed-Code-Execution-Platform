import { useExecutionStore } from '../../state/executionStore';
import { ExecutionStatusBadge } from './ExecutionStatusBadge';

/**
 * Renders exactly what the executionStore holds — the real result of the
 * last POST /execute call, a real error message, or nothing yet. No
 * branch of this component fabricates a success result.
 */
export function OutputPanel() {
  const isRunning = useExecutionStore((s) => s.isRunning);
  const result = useExecutionStore((s) => s.result);
  const error = useExecutionStore((s) => s.error);

  const badgeStatus = isRunning ? 'running' : (result?.status ?? (error ? 'error' : 'idle'));

  return (
    <div className="flex h-full flex-col rounded-lg border border-white/10 bg-neutral-900/60">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <span className="text-xs font-medium tracking-wide text-neutral-400 uppercase">
          Output
        </span>
        <ExecutionStatusBadge status={badgeStatus} />
      </div>

      <div className="flex-1 overflow-auto p-4 font-mono text-sm">
        {isRunning && (
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
            Executing code in an isolated sandbox — first run for a language can take longer
            while its Docker image is pulled.
          </div>
        )}

        {!isRunning && error && (
          <div className="rounded-md border border-red-500/20 bg-red-500/5 p-3 text-red-300">
            {error}
          </div>
        )}

        {!isRunning && !error && !result && (
          <p className="text-neutral-600">Run your code to see output here.</p>
        )}

        {!isRunning && !error && result && (
          <div className="space-y-4">
            {result.stdout && (
              <div>
                <div className="mb-1 text-xs text-neutral-500">stdout</div>
                <pre className="whitespace-pre-wrap text-neutral-200">{result.stdout}</pre>
              </div>
            )}

            {result.stderr && (
              <div>
                <div className="mb-1 text-xs text-neutral-500">stderr</div>
                <pre className="whitespace-pre-wrap text-red-300">{result.stderr}</pre>
              </div>
            )}

            {!result.stdout && !result.stderr && (
              <p className="text-neutral-600">Program produced no output.</p>
            )}

            <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-white/10 pt-3 text-xs text-neutral-500">
              <span>
                Exit code: <span className="text-neutral-300">{result.exit_code ?? 'n/a'}</span>
              </span>
              <span>
                Time: <span className="text-neutral-300">{result.execution_time.toFixed(2)}s</span>
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}