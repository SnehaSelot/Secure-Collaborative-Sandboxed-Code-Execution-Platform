import { useRef, useEffect } from 'react';
import { useExecutionStore } from '../../state/executionStore';
import { ExecutionStatusBadge } from './ExecutionStatusBadge';

const MAX_STDIN_CHARS = 65_536; // backend/app/services/executor.py's MAX_STDIN_CHARS

/**
 * Single integrated Terminal panel — output and stdin input share this one
 * view/component. Stdin is batch/upfront only (see state/executionStore.ts's
 * comment): it's editable before Run, locked while isRunning, and cannot be
 * changed once the program has started.
 */
export function OutputPanel() {
  const isRunning = useExecutionStore((s) => s.isRunning);
  const result = useExecutionStore((s) => s.result);
  const error = useExecutionStore((s) => s.error);
  const terminalLines = useExecutionStore((s) => s.terminalLines);
  const stdoutTruncated = useExecutionStore((s) => s.stdoutTruncated);
  const stderrTruncated = useExecutionStore((s) => s.stderrTruncated);
  const stdin = useExecutionStore((s) => s.stdin);
  const setStdin = useExecutionStore((s) => s.setStdin);

  const terminalEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [terminalLines]);

  const badgeStatus = isRunning ? 'running' : (result?.status ?? (error ? 'error' : 'idle'));

  return (
    <div className="flex h-full flex-col rounded-lg border border-white/10 bg-neutral-900/60">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <span className="text-xs font-medium tracking-wide text-neutral-400 uppercase">
          Terminal
        </span>
        <ExecutionStatusBadge status={badgeStatus} />
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-auto p-4 font-mono text-sm">
          {terminalLines.length === 0 && !isRunning && !result && !error && (
            <p className="text-sm text-neutral-600">Run your code to see output here.</p>
          )}

          {isRunning && terminalLines.length === 0 && (
            <div className="flex items-center gap-2 text-neutral-400">
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" strokeOpacity="0.3" />
                <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
              Executing code in an isolated sandbox...
            </div>
          )}

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

          {(stdoutTruncated || stderrTruncated) && (
            <div className="mt-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-2 text-xs text-amber-400">
              {stdoutTruncated && stderrTruncated
                ? 'stdout and stderr were truncated at the 20,000-character limit.'
                : stdoutTruncated
                  ? 'stdout was truncated at the 20,000-character limit.'
                  : 'stderr was truncated at the 20,000-character limit.'}
            </div>
          )}

          {error && (
            <div className="mt-2 rounded-md border border-red-500/20 bg-red-500/5 p-3 text-red-300">
              {error}
            </div>
          )}

          {!isRunning && result && (
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

        {/*
          Stdin field — still part of this one Terminal panel, not a
          separate component. The backend writes this to the container's
          stdin right after it starts and then closes it (EOF), so it's
          only editable before Run, never during — not a live prompt.
        */}
        <div className="border-t border-white/10 bg-neutral-900/40 px-3 py-2">
          <div className="mb-1 flex items-center justify-between">
            <label htmlFor="terminal-stdin" className="font-mono text-xs text-neutral-500">
              stdin — sent once, when you click Run
            </label>
            {stdin.length > 0 && (
              <span className="font-mono text-xs text-neutral-600">
                {stdin.length.toLocaleString()} / {MAX_STDIN_CHARS.toLocaleString()}
              </span>
            )}
          </div>
          <textarea
            id="terminal-stdin"
            value={stdin}
            onChange={(e) => setStdin(e.target.value)}
            disabled={isRunning}
            maxLength={MAX_STDIN_CHARS}
            placeholder="Optional — each line becomes one input() the program reads"
            rows={2}
            spellCheck={false}
            className="w-full resize-y rounded border border-white/10 bg-neutral-950 px-2 py-1 font-mono text-sm text-neutral-200 outline-none placeholder:text-neutral-600 disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
      </div>
    </div>
  );
}