import { useRef, useEffect } from 'react';
import { useExecutionStore } from '../../state/executionStore';
import { ExecutionStatusBadge } from './ExecutionStatusBadge';
import type { RiskFinding, RiskDecision } from '../../api/riskAnalysis';

const MAX_STDIN_CHARS = 65_536; // backend/app/services/executor.py's MAX_STDIN_CHARS

// ---------------------------------------------------------------------------
// Small helpers for risk UI
// ---------------------------------------------------------------------------

const SEVERITY_PILL_STYLES: Record<string, string> = {
  critical: 'bg-red-500/15 text-red-400 border-red-500/30',
  high: 'bg-red-500/10 text-red-400 border-red-500/20',
  medium: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  low: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
};

const SOURCE_LABEL: Record<string, string> = {
  rule: 'Rule',
  ast: 'AST',
  ml: 'ML',
};

const DECISION_STYLES: Record<RiskDecision, string> = {
  allow: 'border-emerald-500/20 bg-emerald-500/5 text-emerald-400',
  flag: 'border-amber-500/20 bg-amber-500/5 text-amber-400',
  block: 'border-red-500/20 bg-red-500/10 text-red-400',
};

function RiskScoreBadge({ score, decision }: { score: number; decision: RiskDecision }) {
  const style = DECISION_STYLES[decision];
  return (
    <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold tabular-nums ${style}`}>
      {score}/100 · {decision.toUpperCase()}
    </span>
  );
}

function FindingRow({ finding }: { finding: RiskFinding }) {
  const severityStyle = SEVERITY_PILL_STYLES[finding.severity] ?? SEVERITY_PILL_STYLES.low;
  const sourceLabel = SOURCE_LABEL[finding.source] ?? finding.source;

  const lineLabel =
    finding.line_start != null
      ? finding.line_end != null && finding.line_end !== finding.line_start
        ? `lines ${finding.line_start}–${finding.line_end}`
        : `line ${finding.line_start}`
      : null;

  return (
    <li className="rounded-md border border-white/10 bg-neutral-950/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase ${severityStyle}`}
        >
          {finding.severity}
        </span>
        <span className="rounded border border-white/10 bg-neutral-800/60 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">
          {sourceLabel}
        </span>
        <span className="text-sm font-medium text-neutral-100">{finding.message}</span>
        {lineLabel && (
          <span className="text-xs text-neutral-500">{lineLabel}</span>
        )}
        {finding.confidence != null && (
          <span className="text-xs text-neutral-600">
            {(finding.confidence * 100).toFixed(0)}% confidence
          </span>
        )}
      </div>
      {finding.snippet && (
        <pre className="mt-1.5 overflow-x-auto rounded bg-black/30 px-2 py-1 font-mono text-xs text-neutral-400">
          {finding.snippet}
        </pre>
      )}
      <p className="mt-1 text-xs text-neutral-600">{finding.rule_code} · {finding.category}</p>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Risk warning banner (flagged but allowed)
// ---------------------------------------------------------------------------

function RiskWarningBanner({ score, findings = [], model }: {
  score?: number;
  findings?: RiskFinding[];
  model?: string;
}) {
  return (
    <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-amber-400">⚠ Risk Warning</span>
        {score != null && (
          <RiskScoreBadge score={score} decision="flag" />
        )}
        {model && (
          <span className="text-xs text-neutral-500">engine: {model}</span>
        )}
      </div>
      <p className="mt-1 text-xs text-amber-300/70">
        Code was flagged but execution was allowed. Review the findings below.
      </p>
      {findings.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {findings.map((f, i) => <FindingRow key={i} finding={f} />)}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Blocked-by-risk panel
// ---------------------------------------------------------------------------

function BlockedByRiskPanel({ score, findings = [], model, latency_ms }: {
  score?: number;
  findings?: RiskFinding[];
  model?: string;
  latency_ms?: number;
}) {
  return (
    <div className="rounded-md border border-red-500/20 bg-red-500/10 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-bold text-red-400">🛑 Execution Blocked</span>
        {score != null && (
          <RiskScoreBadge score={score} decision="block" />
        )}
        {model && (
          <span className="text-xs text-neutral-500">engine: {model}</span>
        )}
        {latency_ms != null && (
          <span className="text-xs text-neutral-600">{latency_ms.toFixed(1)} ms</span>
        )}
      </div>
      <p className="mt-2 text-sm text-red-300/80">
        The risk analysis engine determined this code is potentially dangerous and blocked
        it from running in the sandbox. No code was executed.
      </p>
      {findings.length > 0 && (
        <>
          <p className="mt-3 text-xs font-medium text-neutral-400">
            {findings.length} finding{findings.length !== 1 ? 's' : ''}:
          </p>
          <ul className="mt-1.5 space-y-1.5">
            {findings.map((f, i) => <FindingRow key={i} finding={f} />)}
          </ul>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

/** Input is sent once before execution; output remains in the terminal below. */
export function OutputPanel() {
  const isRunning = useExecutionStore((s) => s.isRunning);
  const result = useExecutionStore((s) => s.result);
  const error = useExecutionStore((s) => s.error);
  const terminalLines = useExecutionStore((s) => s.terminalLines);
  const stdoutTruncated = useExecutionStore((s) => s.stdoutTruncated);
  const stderrTruncated = useExecutionStore((s) => s.stderrTruncated);
  const stdin = useExecutionStore((s) => s.stdin);
  const setStdin = useExecutionStore((s) => s.setStdin);
  const blockedByRisk = useExecutionStore((s) => s.blockedByRisk);
  const riskWarning = useExecutionStore((s) => s.riskWarning);

  const terminalEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [terminalLines, blockedByRisk, riskWarning]);

  const badgeStatus = isRunning ? 'running' : (result?.status ?? (error ? 'error' : 'idle'));

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <section
        aria-labelledby="terminal-stdin-heading"
        className="shrink-0 rounded-lg border border-white/10 bg-neutral-900/60 p-3"
      >
        <div className="mb-2 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
          <label
            id="terminal-stdin-heading"
            htmlFor="terminal-stdin"
            className="font-mono text-xs font-medium tracking-wide text-neutral-400 uppercase"
          >
            Input (stdin)
          </label>
          <p className="text-xs text-neutral-500">
            Enter input before clicking Run. Input cannot be changed while the program is running.
          </p>
        </div>
        <div className="mb-1 flex justify-end">
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
          rows={3}
          spellCheck={false}
          className="w-full resize-y rounded border border-white/10 bg-neutral-950 px-2 py-1 font-mono text-sm text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-emerald-500/50 disabled:cursor-not-allowed disabled:opacity-50"
        />
      </section>

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-white/10 bg-neutral-900/60">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
          <span className="text-xs font-medium tracking-wide text-neutral-400 uppercase">
            Terminal
          </span>
          <ExecutionStatusBadge status={badgeStatus} />
        </div>

        <div className="flex-1 overflow-auto p-4 font-mono text-sm">
          {terminalLines.length === 0 && !isRunning && !result && !error && !blockedByRisk && (
            <p className="text-sm text-neutral-600">Run your code to see output here.</p>
          )}

          {isRunning && terminalLines.length === 0 && !riskWarning && (
            <div className="flex items-center gap-2 text-neutral-400">
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" strokeOpacity="0.3" />
                <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
              Executing code in an isolated sandbox...
            </div>
          )}

          {/* Risk warning banner (flagged, execution continues) */}
          {riskWarning && (
            <div className="mb-3">
              <RiskWarningBanner
                score={riskWarning.score}
                findings={(riskWarning.findings ?? []) as RiskFinding[]}
                model={riskWarning.model}
              />
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
                      : line.type === 'risk'
                        ? 'text-amber-400'
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

          {/* Blocked by risk gate — full detail panel */}
          {blockedByRisk && (
            <div className="mt-2">
              <BlockedByRiskPanel
                score={blockedByRisk.score}
                findings={(blockedByRisk.findings ?? []) as RiskFinding[]}
                model={blockedByRisk.model}
                latency_ms={blockedByRisk.latency_ms}
              />
            </div>
          )}

          {/* Generic error (non-risk) */}
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
      </section>
    </div>
  );
}