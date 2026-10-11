/**
 * pages/RiskAnalysisPage.tsx — Backend-integrated risk analysis.
 *
 * Replaces the local regex heuristic with POST /risk/analyze, receiving
 * the full ML + static-rule analysis from the backend.
 *
 * Features:
 *  - Calls POST /risk/analyze with Bearer auth (from authStore)
 *  - Displays overall score, Allow/Flag/Block verdict with color-coded badge
 *  - Shows model info (rules / rules+ml), latency, and assessment ID
 *  - Renders findings table: severity pill, source badge, line numbers,
 *    confidence, snippet, and category
 *  - Findings with line numbers are clickable and navigate Monaco to that line
 *  - Handles: loading, empty code, truncated input, no findings, auth errors,
 *    400/401/503 error responses, and network failures
 *  - Truncated-input warning when input exceeded backend scan limit
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useWorkspaceStore } from '../state/workspaceStore';
import { useAuthStore } from '../state/authStore';
import { analyzeCodeRisk, type RiskAnalysisResponse, type RiskFinding, type RiskDecision } from '../api/riskAnalysis';
import { extractErrorMessage } from '../api/client';
import { getFileDocumentContent } from '../state/fileDocumentRegistry';

// ---------------------------------------------------------------------------
// Styling constants
// ---------------------------------------------------------------------------

const DECISION_STYLES: Record<RiskDecision, { badge: string; border: string; label: string }> = {
  allow: {
    badge: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400',
    border: 'border-emerald-500/20',
    label: 'Allow',
  },
  flag: {
    badge: 'bg-amber-500/15 border-amber-500/30 text-amber-400',
    border: 'border-amber-500/20',
    label: 'Flag',
  },
  block: {
    badge: 'bg-red-500/15 border-red-500/30 text-red-400',
    border: 'border-red-500/20',
    label: 'Block',
  },
};

const SEVERITY_STYLES: Record<string, string> = {
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

const SOURCE_BADGE_STYLES: Record<string, string> = {
  rule: 'text-neutral-400 border-neutral-600/50 bg-neutral-800/60',
  ast:  'text-violet-400 border-violet-500/30 bg-violet-500/10',
  ml:   'text-sky-400 border-sky-500/30 bg-sky-500/10',
};

// ---------------------------------------------------------------------------
// Score bar
// ---------------------------------------------------------------------------

function ScoreBar({ score, thresholds }: { score: number; thresholds: { flag: number; block: number } }) {
  const clampedScore = Math.min(100, Math.max(0, score));
  const color =
    clampedScore >= thresholds.block
      ? 'bg-red-500'
      : clampedScore >= thresholds.flag
      ? 'bg-amber-500'
      : 'bg-emerald-500';

  return (
    <div className="mt-2 space-y-1">
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-neutral-800">
        {/* flag threshold marker */}
        <div
          className="absolute top-0 h-full w-px bg-amber-500/60"
          style={{ left: `${thresholds.flag}%` }}
        />
        {/* block threshold marker */}
        <div
          className="absolute top-0 h-full w-px bg-red-500/60"
          style={{ left: `${thresholds.block}%` }}
        />
        {/* score fill */}
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${clampedScore}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-neutral-600">
        <span>0</span>
        <span className="text-amber-500/70">flag ≥{thresholds.flag}</span>
        <span className="text-red-500/70">block ≥{thresholds.block}</span>
        <span>100</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Finding row with optional Monaco navigation
// ---------------------------------------------------------------------------

function FindingItem({
  finding,
  onGoToLine,
}: {
  finding: RiskFinding;
  onGoToLine?: (line: number) => void;
}) {
  const severityStyle = SEVERITY_STYLES[finding.severity] ?? SEVERITY_STYLES.low;
  const sourceStyle = SOURCE_BADGE_STYLES[finding.source] ?? SOURCE_BADGE_STYLES.rule;
  const sourceLabel = SOURCE_LABEL[finding.source] ?? finding.source;

  const lineLabel =
    finding.line_start != null
      ? finding.line_end != null && finding.line_end !== finding.line_start
        ? `lines ${finding.line_start}–${finding.line_end}`
        : `line ${finding.line_start}`
      : null;

  const canNavigate = finding.line_start != null && onGoToLine != null;

  return (
    <li className="rounded-md border border-white/10 bg-neutral-950/60 p-3 transition hover:border-white/15">
      <div className="flex flex-wrap items-center gap-2">
        {/* Severity pill */}
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase ${severityStyle}`}
        >
          {finding.severity}
        </span>

        {/* Source badge */}
        <span
          className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium ${sourceStyle}`}
        >
          {sourceLabel}
        </span>

        {/* Message */}
        <span className="flex-1 text-sm font-medium text-neutral-100">{finding.message}</span>

        {/* Line number — clickable if Monaco navigation available */}
        {lineLabel && (
          canNavigate ? (
            <button
              type="button"
              onClick={() => onGoToLine!(finding.line_start!)}
              className="rounded border border-white/10 bg-neutral-900 px-2 py-0.5 font-mono text-xs text-emerald-400 transition hover:border-emerald-500/30 hover:bg-emerald-500/10"
              title={`Go to ${lineLabel} in editor`}
            >
              ↗ {lineLabel}
            </button>
          ) : (
            <span className="text-xs text-neutral-500">{lineLabel}</span>
          )
        )}

        {/* Confidence */}
        {finding.confidence != null && (
          <span className="text-xs text-neutral-600">
            {(finding.confidence * 100).toFixed(0)}%
          </span>
        )}
      </div>

      {/* Code snippet */}
      {finding.snippet && (
        <pre className="mt-1.5 overflow-x-auto rounded bg-black/30 px-2.5 py-1.5 font-mono text-xs text-neutral-400">
          {finding.snippet}
        </pre>
      )}

      {/* Rule code + category */}
      <p className="mt-1.5 text-[10px] text-neutral-600">
        {finding.rule_code} · {finding.category}
      </p>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

type PageState =
  | { phase: 'idle' }
  | { phase: 'analyzing' }
  | { phase: 'done'; result: RiskAnalysisResponse }
  | { phase: 'error'; message: string };

export function RiskAnalysisPage() {
  const nodes = useWorkspaceStore((s) => s.nodes);
  const activeFileId = useWorkspaceStore((s) => s.activeFileId);
  const user = useAuthStore((s) => s.user);

  const files = Object.values(nodes).filter((n) => n.type === 'file');

  const [selectedId, setSelectedId] = useState<string | null>(activeFileId);
  const [pageState, setPageState] = useState<PageState>({ phase: 'idle' });

  const selectedFile = selectedId ? nodes[selectedId] : undefined;

  // Navigation callback from the active Monaco editor.
  // Stored in a ref (for the actual call) and mirrored into state (for
  // render-time conditional display) — refs must not be read during render.
  const monacoGoToLineRef = useRef<((line: number) => void) | null>(null);
  const [canNavigate, setCanNavigate] = useState(false);

  // Listen for "monaco-ready" events dispatched by CodeEditor on mount.
  const handleMonacoNavigate = useCallback((e: Event) => {
    const ce = e as CustomEvent<{ fileId: string; goToLine: (line: number) => void }>;
    if (ce.detail.fileId === selectedId) {
      monacoGoToLineRef.current = ce.detail.goToLine;
      setCanNavigate(true);
    }
  }, [selectedId]);

  useEffect(() => {
    window.addEventListener('monaco-ready', handleMonacoNavigate as EventListener);
    return () => window.removeEventListener('monaco-ready', handleMonacoNavigate as EventListener);
  }, [handleMonacoNavigate]);

  const handleAnalyze = useCallback(async () => {
    if (!selectedFile) return;

    // Get the live editor content (may differ from store if user hasn't saved)
    const liveContent = selectedId
      ? (getFileDocumentContent(selectedId) ?? selectedFile.content ?? '')
      : (selectedFile.content ?? '');

    const language = selectedFile.language ?? 'plaintext';

    if (!liveContent.trim()) {
      setPageState({ phase: 'error', message: 'The selected file is empty. Add some code before analyzing.' });
      return;
    }

    if (language === 'plaintext') {
      setPageState({
        phase: 'error',
        message: 'Risk analysis requires a specific language (e.g. Python, JavaScript). Set the language in the Editor first.',
      });
      return;
    }

    setPageState({ phase: 'analyzing' });
    try {
      const result = await analyzeCodeRisk(language, liveContent, user?.token);
      setPageState({ phase: 'done', result });
    } catch (err) {
      // Map known error codes to friendly messages
      const raw = extractErrorMessage(err);
      let message = raw;
      if (raw.includes('401') || raw.includes('Unauthorized') || raw.includes('credentials')) {
        message = 'Authentication required. Sign in via the Collaboration page to use risk analysis.';
      } else if (raw.includes('400') || raw.includes('Bad Request')) {
        message = `Invalid request: ${raw}. Check that the language is supported (python, javascript, go, java, c, cpp, rust).`;
      } else if (raw.includes('503') || raw.includes('Service Unavailable') || raw.includes('risk_unavailable')) {
        message = 'The risk engine is temporarily unavailable (fail-closed mode). Try again shortly.';
      }
      setPageState({ phase: 'error', message });
    }
  }, [selectedFile, selectedId, user]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const result = pageState.phase === 'done' ? pageState.result : null;

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-lg font-semibold text-neutral-100">Risk Analysis</h1>
        </div>
      </div>

      {/* File selector + Analyze button */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-neutral-900/60 p-4">
        <label htmlFor="risk-file-select" className="text-sm text-neutral-400">
          File
        </label>
        <select
          id="risk-file-select"
          value={selectedId ?? ''}
          onChange={(e) => {
            setSelectedId(e.target.value || null);
            setPageState({ phase: 'idle' });
            monacoGoToLineRef.current = null;
            setCanNavigate(false);
          }}
          className="rounded-md border border-white/10 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-200 outline-none focus:border-emerald-500/50"
        >
          <option value="" disabled>
            Select a file…
          </option>
          {files.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => void handleAnalyze()}
          disabled={!selectedFile || pageState.phase === 'analyzing'}
          className="rounded-md bg-emerald-500 px-4 py-1.5 text-sm font-medium text-neutral-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-emerald-500/40"
        >
          {pageState.phase === 'analyzing' ? (
            <span className="flex items-center gap-2">
              <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" strokeOpacity="0.3" />
                <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
              Analyzing…
            </span>
          ) : (
            'Analyze'
          )}
        </button>

        {files.length === 0 && (
          <span className="text-sm text-neutral-600">
            No files yet — create one in the Editor first.
          </span>
        )}
      </div>

      {/* Results area */}
      <div className="min-h-0 flex-1 overflow-auto space-y-4">

        {/* Idle state */}
        {pageState.phase === 'idle' && (
          <div className="rounded-lg border border-white/10 bg-neutral-900/60 p-4">
            <p className="text-sm text-neutral-600">Select a file and click Analyze.</p>
          </div>
        )}

        {/* Analyzing state */}
        {pageState.phase === 'analyzing' && (
          <div className="rounded-lg border border-white/10 bg-neutral-900/60 p-6 flex items-center gap-3 text-sm text-neutral-400">
            <svg className="h-4 w-4 animate-spin shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" strokeOpacity="0.3" />
              <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
            Running backend risk analysis…
          </div>
        )}

        {/* Error state */}
        {pageState.phase === 'error' && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4" role="alert">
            <p className="text-sm font-medium text-red-400">Analysis failed</p>
            <p className="mt-1 text-sm text-red-300/80">{pageState.message}</p>
            <button
              type="button"
              onClick={() => setPageState({ phase: 'idle' })}
              className="mt-3 text-xs text-neutral-500 hover:text-neutral-300"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Results */}
        {result && (
          <>
            {/* Summary card */}
            <div className={`rounded-lg border bg-neutral-900/60 p-4 ${DECISION_STYLES[result.decision].border}`}>
              <div className="flex flex-wrap items-center gap-3">
                {/* Verdict badge */}
                <span
                  className={`rounded-full border px-3 py-1 text-sm font-bold ${DECISION_STYLES[result.decision].badge}`}
                >
                  {DECISION_STYLES[result.decision].label}
                </span>

                {/* Score */}
                <span className="text-sm text-neutral-400">
                  Score: <span className="font-semibold text-neutral-100 tabular-nums">{result.score.toFixed(1)}</span>
                  <span className="text-neutral-600"> / 100</span>
                </span>

                {/* Engine model */}
                <span className="rounded border border-white/10 bg-neutral-800/60 px-2 py-0.5 text-xs text-neutral-400">
                  {result.model}
                </span>

                {/* ML score if available */}
                {result.ml_score != null && (
                  <span className="text-xs text-sky-400/80">
                    ML: {result.ml_score.toFixed(1)}%
                  </span>
                )}

                {/* Latency */}
                <span className="text-xs text-neutral-600">
                  {result.latency_ms.toFixed(1)} ms
                </span>

                {/* Truncated warning */}
                {result.truncated && (
                  <span className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-400">
                    ⚠ input truncated
                  </span>
                )}

                {/* Engine error */}
                {result.error && (
                  <span className="rounded border border-red-500/20 bg-red-500/10 px-2 py-0.5 text-xs text-red-400">
                    engine: {result.error}
                  </span>
                )}

                {/* Fallback reason (ML skipped) */}
                {result.fallback_reason && (
                  <span className="text-xs text-neutral-600">
                    ({result.fallback_reason})
                  </span>
                )}
              </div>

              {/* Score bar */}
              <ScoreBar score={result.score} thresholds={result.thresholds} />

              {/* Truncated-input notice */}
              {result.truncated && (
                <p className="mt-2 text-xs text-amber-400/80">
                  The file exceeds the scan limit (400 000 chars). The analysis only covers the
                  beginning of the file — the remaining code was not inspected.
                </p>
              )}

              {/* Assessment ID for correlation */}
              {result.assessment_id && (
                <p className="mt-2 font-mono text-[10px] text-neutral-700">
                  id: {result.assessment_id}
                </p>
              )}
            </div>

            {/* Findings */}
            <div className="rounded-lg border border-white/10 bg-neutral-900/60 p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-medium text-neutral-300">
                  {result.findings.length === 0
                    ? 'No findings'
                    : `${result.findings.length} finding${result.findings.length !== 1 ? 's' : ''}`}
                </h2>
                {result.findings.length > 0 && (
                  <span className="text-xs text-neutral-600">
                    Sorted by severity · {canNavigate ? 'click line to navigate' : 'open file in Editor to navigate lines'}
                  </span>
                )}
              </div>

              {result.findings.length === 0 ? (
                <p className="text-sm text-emerald-400">
                  No patterns detected in <span className="font-medium">{selectedFile?.name}</span>.
                  {result.decision === 'allow' && ' Code is cleared for execution.'}
                </p>
              ) : (
                <ul className="space-y-2">
                  {/* Sort: critical → high → medium → low, then by line */}
                  {[...result.findings]
                    .sort((a, b) => {
                      const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
                      const diff = (order[a.severity] ?? 4) - (order[b.severity] ?? 4);
                      if (diff !== 0) return diff;
                      return (a.line_start ?? 9999) - (b.line_start ?? 9999);
                    })
                    .map((finding, idx) => (
                      <FindingItem
                        key={idx}
                        finding={finding}
                        onGoToLine={canNavigate ? (line) => monacoGoToLineRef.current?.(line) : undefined}
                      />
                    ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
