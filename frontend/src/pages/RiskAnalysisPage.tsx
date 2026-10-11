/**
 * pages/RiskAnalysisPage.tsx — Backend-integrated risk analysis for both
 * Main Editor and Collaboration files.
 *
 * Features:
 *  - Supports files from BOTH the Main Editor workspace and active Collaboration session
 *  - Clearly indicates file source (Main Editor or Collaboration · Room ID/Name)
 *  - Analyzes the latest shared code for collaboration files (live Yjs or REST API)
 *  - Handles empty sessions, closed sessions, deleted/unavailable files, and loading states
 *  - Reuses the existing POST /risk/analyze API and rich results UI
 *  - Monaco line navigation preserved for open documents
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useWorkspaceStore } from '../state/workspaceStore';
import { useAuthStore } from '../state/authStore';
import { useCollabStore } from '../state/collaborationStore';
import { getCollabFile } from '../api/collaborationApi';
import {
  analyzeCodeRisk,
  type RiskAnalysisResponse,
  type RiskFinding,
  type RiskDecision,
} from '../api/riskAnalysis';
import { extractErrorMessage } from '../api/client';
import { getFileDocumentContent } from '../state/fileDocumentRegistry';
import { detectLanguageFromFilename } from '../config/languageTemplates';
import { isValidRoomId } from '../collaboration/session';

// ---------------------------------------------------------------------------
// Types & Styling
// ---------------------------------------------------------------------------

export type FileSource = 'main' | 'collaboration';

export interface SelectableFile {
  key: string; // e.g. "main:<fileId>" or "collab:<fileId>"
  id: string; // fileId
  name: string; // file path or name
  source: FileSource;
  language: string;
  sessionId?: string;
  sessionName?: string;
  sessionStatus?: string;
}

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
  ast: 'text-violet-400 border-violet-500/30 bg-violet-500/10',
  ml: 'text-sky-400 border-sky-500/30 bg-sky-500/10',
};

// ---------------------------------------------------------------------------
// Score Bar
// ---------------------------------------------------------------------------

function ScoreBar({
  score,
  thresholds,
}: {
  score: number;
  thresholds: { flag: number; block: number };
}) {
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
        <div
          className="absolute top-0 h-full w-px bg-amber-500/60"
          style={{ left: `${thresholds.flag}%` }}
        />
        <div
          className="absolute top-0 h-full w-px bg-red-500/60"
          style={{ left: `${thresholds.block}%` }}
        />
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
// Finding Item
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
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase ${severityStyle}`}
        >
          {finding.severity}
        </span>
        <span
          className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium ${sourceStyle}`}
        >
          {sourceLabel}
        </span>
        <span className="flex-1 text-sm font-medium text-neutral-100">{finding.message}</span>
        {lineLabel &&
          (canNavigate ? (
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
          ))}
        {finding.confidence != null && (
          <span className="text-xs text-neutral-600">
            {(finding.confidence * 100).toFixed(0)}%
          </span>
        )}
      </div>
      {finding.snippet && (
        <pre className="mt-1.5 overflow-x-auto rounded bg-black/30 px-2.5 py-1.5 font-mono text-xs text-neutral-400">
          {finding.snippet}
        </pre>
      )}
      <p className="mt-1.5 text-[10px] text-neutral-600">
        {finding.rule_code} · {finding.category}
      </p>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Main Page Component
// ---------------------------------------------------------------------------

type PageState =
  | { phase: 'idle' }
  | { phase: 'analyzing'; message?: string }
  | { phase: 'done'; result: RiskAnalysisResponse }
  | { phase: 'error'; message: string };

export function RiskAnalysisPage() {
  const nodes = useWorkspaceStore((s) => s.nodes);
  const activeMainFileId = useWorkspaceStore((s) => s.activeFileId);
  const user = useAuthStore((s) => s.user);

  // Active collaboration session state
  const activeSession = useCollabStore((s) => s.activeSession);
  const sessionFiles = useCollabStore((s) => s.sessionFiles);
  const isCollabLoading = useCollabStore((s) => s.isLoading);
  const sessionError = useCollabStore((s) => s.sessionError);

  const [sourceFilter, setSourceFilter] = useState<'all' | 'main' | 'collab'>('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [pageState, setPageState] = useState<PageState>({ phase: 'idle' });

  // Monaco navigation reference
  const monacoGoToLineRef = useRef<((line: number) => void) | null>(null);
  const [canNavigate, setCanNavigate] = useState(false);

  // Auto-restore collaboration session from sessionStorage if not currently in memory
  useEffect(() => {
    if (activeSession || !user?.token) return;
    try {
      const storedRoomId = sessionStorage.getItem('glasshouse:last-collaboration-room');
      if (storedRoomId && isValidRoomId(storedRoomId)) {
        void useCollabStore.getState().refreshSession(storedRoomId, user.token);
      }
    } catch {
      // Ignore sessionStorage issues
    }
  }, [activeSession, user?.token]);

  // Construct list of Main Editor files
  const mainFiles = useMemo<SelectableFile[]>(() => {
    return Object.values(nodes)
      .filter((n) => n.type === 'file')
      .map((f) => ({
        key: `main:${f.id}`,
        id: f.id,
        name: f.name,
        source: 'main',
        language: f.language ?? detectLanguageFromFilename(f.name) ?? 'plaintext',
      }));
  }, [nodes]);

  // Construct list of Collaboration files
  const collabFiles = useMemo<SelectableFile[]>(() => {
    if (!activeSession) return [];
    return sessionFiles.map((f) => ({
      key: `collab:${f.id}`,
      id: f.id,
      name: f.path,
      source: 'collaboration',
      language: f.language ?? detectLanguageFromFilename(f.path) ?? 'plaintext',
      sessionId: activeSession.session_id,
      sessionName: activeSession.name,
      sessionStatus: activeSession.status,
    }));
  }, [activeSession, sessionFiles]);

  // All combined selectable files
  const allFiles = useMemo<SelectableFile[]>(() => {
    return [...mainFiles, ...collabFiles];
  }, [mainFiles, collabFiles]);

  // Filtered list based on active tab
  const displayedFiles = useMemo<SelectableFile[]>(() => {
    if (sourceFilter === 'main') return mainFiles;
    if (sourceFilter === 'collab') return collabFiles;
    return allFiles;
  }, [sourceFilter, mainFiles, collabFiles, allFiles]);

  // Compute the effective selected key: either user's explicit selection if valid,
  // or the highest priority available file (Main active -> Main first -> Collab first).
  const effectiveSelectedKey = useMemo(() => {
    if (selectedKey && allFiles.some((f) => f.key === selectedKey)) {
      return selectedKey;
    }
    if (activeMainFileId && mainFiles.some((f) => f.id === activeMainFileId)) {
      return `main:${activeMainFileId}`;
    }
    if (mainFiles.length > 0) {
      return mainFiles[0].key;
    }
    if (collabFiles.length > 0) {
      return collabFiles[0].key;
    }
    return null;
  }, [selectedKey, allFiles, activeMainFileId, mainFiles, collabFiles]);

  // The currently selected file object
  const selectedFile = useMemo<SelectableFile | undefined>(() => {
    return allFiles.find((f) => f.key === effectiveSelectedKey);
  }, [allFiles, effectiveSelectedKey]);

  // Listen for Monaco mount events in either editor
  const handleMonacoNavigate = useCallback(
    (e: Event) => {
      const ce = e as CustomEvent<{ fileId: string; goToLine: (line: number) => void }>;
      if (selectedFile && ce.detail.fileId === selectedFile.id) {
        monacoGoToLineRef.current = ce.detail.goToLine;
        setCanNavigate(true);
      }
    },
    [selectedFile],
  );

  useEffect(() => {
    window.addEventListener('monaco-ready', handleMonacoNavigate as EventListener);
    return () => window.removeEventListener('monaco-ready', handleMonacoNavigate as EventListener);
  }, [handleMonacoNavigate]);

  // ---------------------------------------------------------------------------
  // Risk Analysis Handler
  // ---------------------------------------------------------------------------

  const handleAnalyze = useCallback(async () => {
    if (!selectedFile) return;

    setPageState({ phase: 'analyzing', message: 'Retrieving latest code content…' });

    try {
      let codeToAnalyze = '';
      let languageToAnalyze = selectedFile.language;

      if (selectedFile.source === 'main') {
        // Read from Main Editor (Yjs doc or store)
        codeToAnalyze =
          getFileDocumentContent(selectedFile.id) ?? nodes[selectedFile.id]?.content ?? '';
      } else {
        // Read from Collaboration session
        const sessionId = selectedFile.sessionId ?? activeSession?.session_id;
        if (!sessionId) {
          setPageState({
            phase: 'error',
            message: 'Collaboration session ID is missing for this file.',
          });
          return;
        }

        // F5/F6: Check if live Yjs document has latest in-memory unsaved changes
        const liveYjs = getFileDocumentContent(selectedFile.id, sessionId);
        if (liveYjs !== null && liveYjs !== undefined && liveYjs.trim().length > 0) {
          codeToAnalyze = liveYjs;
        } else if (user?.token) {
          // Requirement 3: Fetch latest shared content from the server
          try {
            const detail = await getCollabFile(sessionId, selectedFile.id, user.token);
            codeToAnalyze = detail.content ?? '';
            if (detail.language) {
              languageToAnalyze = detail.language;
            }
          } catch (fetchErr) {
            const raw = extractErrorMessage(fetchErr);
            if (raw.includes('404') || raw.includes('not found')) {
              setPageState({
                phase: 'error',
                message: `Shared file "${selectedFile.name}" was not found. It may have been deleted or renamed by another participant.`,
              });
              return;
            }
            if (raw.includes('403') || raw.includes('Not a member')) {
              setPageState({
                phase: 'error',
                message:
                  'Access denied: You are not an authorized member of this collaboration session.',
              });
              return;
            }
            if (raw.includes('409') || raw.includes('closed')) {
              setPageState({
                phase: 'error',
                message: 'This collaboration session is closed.',
              });
              return;
            }
            throw fetchErr;
          }
        } else {
          // Fallback if unauthenticated:
          const cached = sessionFiles.find((f) => f.id === selectedFile.id);
          codeToAnalyze = cached?.content ?? '';
        }
      }

      if (!codeToAnalyze.trim()) {
        setPageState({
          phase: 'error',
          message: 'The selected file is empty. Add some code before analyzing.',
        });
        return;
      }

      if (languageToAnalyze === 'plaintext' || !languageToAnalyze) {
        setPageState({
          phase: 'error',
          message:
            'Risk analysis requires a specific language (e.g. Python, JavaScript, Go, Java, C, C++, Rust). Set the file language before analyzing.',
        });
        return;
      }

      setPageState({ phase: 'analyzing', message: 'Running backend risk analysis…' });

      const result = await analyzeCodeRisk(languageToAnalyze, codeToAnalyze, user?.token);
      setPageState({ phase: 'done', result });
    } catch (err) {
      const raw = extractErrorMessage(err);
      let message = raw;
      if (raw.includes('401') || raw.includes('Unauthorized') || raw.includes('credentials')) {
        message = 'Authentication required. Sign in via the Collaboration page to use risk analysis.';
      } else if (raw.includes('400') || raw.includes('Bad Request')) {
        message = `Invalid request: ${raw}. Check that the language is supported (python, javascript, go, java, c, cpp, rust).`;
      } else if (
        raw.includes('503') ||
        raw.includes('Service Unavailable') ||
        raw.includes('risk_unavailable')
      ) {
        message = 'The risk engine is temporarily unavailable (fail-closed mode). Try again shortly.';
      }
      setPageState({ phase: 'error', message });
    }
  }, [selectedFile, nodes, activeSession, user, sessionFiles]);

  const result = pageState.phase === 'done' ? pageState.result : null;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-neutral-100">Risk Analysis</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Analyze code for security risks across your editor and collaboration sessions.
          </p>
        </div>
      </div>

      {/* Active Collaboration Session Status Banner */}
      {activeSession ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-sky-500/20 bg-sky-500/5 px-5 py-4 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 font-medium text-sky-400">
              Active Room
            </span>
            <span className="font-medium text-neutral-200">{activeSession.name}</span>
          </div>

          <Link
            to={`/collaboration/${encodeURIComponent(activeSession.session_id)}`}
            className="text-sky-400 transition hover:text-sky-300 hover:underline"
          >
            Open room in Collaboration ↗
          </Link>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/5 bg-neutral-900/40 px-4 py-2 text-xs text-neutral-500">
          <span>
            No active collaboration session.{' '}
            <Link to="/collaboration" className="text-emerald-400 hover:underline">
              Create or join a room
            </Link>{' '}
            to analyze shared collaboration files here.
          </span>
          {isCollabLoading && <span>Restoring session…</span>}
        </div>
      )}

      {/* Session error or closed warning */}
      {sessionError && (
        <div className="rounded-md border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-300">
          {sessionError}
        </div>
      )}
      {activeSession?.status === 'closed' && (
        <div className="rounded-md border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-300">
          This collaboration session is closed. Shared files are read-only.
        </div>
      )}

      {/* Source Filter and File Selector Card */}
      <div className="flex flex-col gap-5 rounded-lg border border-white/10 bg-neutral-900/60 p-5">
        {/* Source Filter Tabs */}
        <div className="flex flex-wrap items-center gap-3 border-b border-white/10 pb-4">
          <div className="flex items-center gap-1.5" role="tablist" aria-label="File source filter">
            <button
              type="button"
              role="tab"
              aria-selected={sourceFilter === 'all'}
              onClick={() => setSourceFilter('all')}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                sourceFilter === 'all'
                  ? 'bg-neutral-800 text-neutral-100 shadow-sm'
                  : 'text-neutral-400 hover:bg-neutral-800/40 hover:text-neutral-200'
              }`}
            >
              All Files ({allFiles.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sourceFilter === 'main'}
              onClick={() => setSourceFilter('main')}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                sourceFilter === 'main'
                  ? 'bg-neutral-800 text-neutral-100 shadow-sm'
                  : 'text-neutral-400 hover:bg-neutral-800/40 hover:text-neutral-200'
              }`}
            >
              Main Editor ({mainFiles.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sourceFilter === 'collab'}
              onClick={() => setSourceFilter('collab')}
              disabled={!activeSession}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                sourceFilter === 'collab'
                  ? 'bg-sky-500/20 text-sky-300 shadow-sm'
                  : 'text-neutral-400 hover:bg-neutral-800/40 hover:text-neutral-200'
              }`}
            >
              Collaboration ({collabFiles.length})
            </button>
          </div>

          
        </div>

        {/* Dropdown & Analyze Button */}
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor="risk-file-select" className="text-sm text-neutral-400">
            File
          </label>
          <select
            id="risk-file-select"
            value={effectiveSelectedKey ?? ''}
            onChange={(e) => {
              setSelectedKey(e.target.value || null);
              setPageState({ phase: 'idle' });
              monacoGoToLineRef.current = null;
              setCanNavigate(false);
            }}
            className="min-w-64 max-w-md rounded-md border border-white/10 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-200 outline-none focus:border-emerald-500/50"
          >
            <option value="" disabled>
              Select a file…
            </option>

            {/* Main Editor Files Group */}
            {(sourceFilter === 'all' || sourceFilter === 'main') && mainFiles.length > 0 && (
              <optgroup label="Main Editor Files">
                {mainFiles.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.name} (Main Editor)
                  </option>
                ))}
              </optgroup>
            )}

            {/* Collaboration Files Group */}
            {(sourceFilter === 'all' || sourceFilter === 'collab') && activeSession && (
              <optgroup
                label={`Collaboration — ${activeSession.name} (${activeSession.session_id.slice(0, 8)}…)`}
              >
                {collabFiles.length === 0 ? (
                  <option value="" disabled>
                    (No shared files in collaboration session)
                  </option>
                ) : (
                  collabFiles.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.name} (Collaboration)
                    </option>
                  ))
                )}
              </optgroup>
            )}
          </select>

          <button
            type="button"
            onClick={() => void handleAnalyze()}
            disabled={!selectedFile || pageState.phase === 'analyzing'}
            className="rounded-md bg-emerald-500 px-4 py-1.5 text-sm font-medium text-neutral-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-emerald-500/40"
          >
            {pageState.phase === 'analyzing' ? (
              <span className="flex items-center gap-2">
                <svg
                  className="h-3.5 w-3.5 animate-spin"
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
                Analyzing…
              </span>
            ) : (
              'Analyze'
            )}
          </button>

          {displayedFiles.length === 0 && (
            <span className="text-sm text-neutral-600">
              No files available under this filter.
            </span>
          )}
        </div>
      </div>

      {/* Results Area */}
      <div className="min-h-0 flex-1 overflow-auto space-y-6">
        {/* Idle state */}
        {pageState.phase === 'idle' && (
          <div className="rounded-lg border border-white/10 bg-neutral-900/60 p-4">
            <p className="text-sm text-neutral-600">Select a file and click Analyze.</p>
          </div>
        )}

        {/* Analyzing state */}
        {pageState.phase === 'analyzing' && (
          <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-neutral-900/60 p-6 text-sm text-neutral-400">
            <svg
              className="h-4 w-4 animate-spin shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" strokeOpacity="0.3" />
              <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
            {pageState.message ?? 'Running backend risk analysis…'}
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

        {/* Results display */}
        {result && (
          <>
            {/* Summary card */}
            <div
              className={`rounded-lg border bg-neutral-900/60 p-4 ${
                DECISION_STYLES[result.decision].border
              }`}
            >
              <div className="flex flex-wrap items-center gap-3">
                {/* Verdict badge */}
                <span
                  className={`rounded-full border px-3 py-1 text-sm font-bold ${
                    DECISION_STYLES[result.decision].badge
                  }`}
                >
                  {DECISION_STYLES[result.decision].label}
                </span>

                {/* Score */}
                <span className="text-sm text-neutral-400">
                  Score:{' '}
                  <span className="font-semibold text-neutral-100 tabular-nums">
                    {result.score.toFixed(1)}
                  </span>
                  <span className="text-neutral-600"> / 100</span>
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

                {/* Fallback reason */}
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

              {/* Assessment ID */}
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
                    Sorted by severity ·{' '}
                    {canNavigate
                      ? 'click line to navigate'
                      : 'open file in Editor to navigate lines'}
                  </span>
                )}
              </div>

              {result.findings.length === 0 ? (
                <p className="text-sm text-emerald-400">
                  No patterns detected in{' '}
                  <span className="font-medium">{selectedFile?.name}</span>.
                  {result.decision === 'allow' && ' Code is cleared for execution.'}
                </p>
              ) : (
                <ul className="space-y-2">
                  {[...result.findings]
                    .sort((a, b) => {
                      const order: Record<string, number> = {
                        critical: 0,
                        high: 1,
                        medium: 2,
                        low: 3,
                      };
                      const diff = (order[a.severity] ?? 4) - (order[b.severity] ?? 4);
                      if (diff !== 0) return diff;
                      return (a.line_start ?? 9999) - (b.line_start ?? 9999);
                    })
                    .map((finding, idx) => (
                      <FindingItem
                        key={idx}
                        finding={finding}
                        onGoToLine={
                          canNavigate
                            ? (line) => monacoGoToLineRef.current?.(line)
                            : undefined
                        }
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
