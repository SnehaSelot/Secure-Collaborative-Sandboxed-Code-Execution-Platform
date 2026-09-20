import { useMemo, useState } from 'react';
import { useWorkspaceStore } from '../state/workspaceStore';
import { analyzeRiskHeuristic, type RiskFinding, type RiskSeverity } from '../utils/riskScanner';

const SEVERITY_STYLES: Record<RiskSeverity, string> = {
  high: 'bg-red-500/10 text-red-400 border-red-500/20',
  medium: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  low: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
};

/**
 * Preview implementation: scans a file's code entirely client-side with
 * regex heuristics (utils/riskScanner.ts) — NOT the AI risk-analysis
 * service AppRoutes.tsx originally described as the eventual /risk
 * feature. See riskScanner.ts's header comment for what a real backend
 * integration here needs to look like.
 */
export function RiskAnalysisPage() {
  const nodes = useWorkspaceStore((s) => s.nodes);
  const activeFileId = useWorkspaceStore((s) => s.activeFileId);

  const files = useMemo(() => Object.values(nodes).filter((n) => n.type === 'file'), [nodes]);

  const [selectedId, setSelectedId] = useState<string | null>(activeFileId);
  const [findings, setFindings] = useState<RiskFinding[] | null>(null);

  const selectedFile = selectedId ? nodes[selectedId] : undefined;

  const handleAnalyze = () => {
    if (!selectedFile) return;
    setFindings(analyzeRiskHeuristic(selectedFile.content ?? '', selectedFile.language ?? ''));
  };

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-neutral-100">Risk Analysis</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Local heuristic preview — scans for known-risky patterns in your browser, no code
            leaves your machine. Not yet the full AI-backed analysis service.
          </p>
        </div>
        <span className="inline-block rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-400">
          Preview
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-neutral-900/60 p-4">
        <label htmlFor="risk-file-select" className="text-sm text-neutral-400">
          File
        </label>
        <select
          id="risk-file-select"
          value={selectedId ?? ''}
          onChange={(e) => {
            setSelectedId(e.target.value || null);
            setFindings(null);
          }}
          className="rounded-md border border-white/10 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-200 outline-none"
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
          onClick={handleAnalyze}
          disabled={!selectedFile}
          className="rounded-md bg-emerald-500 px-4 py-1.5 text-sm font-medium text-neutral-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-emerald-500/40"
        >
          Analyze
        </button>

        {files.length === 0 && (
          <span className="text-sm text-neutral-600">
            No files yet — create one in the Editor first.
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-white/10 bg-neutral-900/60 p-4">
        {findings === null && (
          <p className="text-sm text-neutral-600">Select a file and click Analyze.</p>
        )}

        {findings !== null && findings.length === 0 && (
          <p className="text-sm text-emerald-400">
            No known-risky patterns found in {selectedFile?.name}. This is a heuristic scan, not a
            guarantee of safety.
          </p>
        )}

        {findings !== null && findings.length > 0 && (
          <ul className="space-y-2">
            {findings.map((f, idx) => (
              <li key={idx} className="rounded-md border border-white/10 bg-neutral-950/60 p-3">
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase ${SEVERITY_STYLES[f.severity]}`}
                  >
                    {f.severity}
                  </span>
                  <span className="text-sm font-medium text-neutral-100">{f.title}</span>
                  {f.line !== undefined && (
                    <span className="text-xs text-neutral-500">line {f.line}</span>
                  )}
                </div>
                <p className="mt-1 text-sm text-neutral-400">{f.description}</p>
                <pre className="mt-1 overflow-x-auto rounded bg-black/30 px-2 py-1 font-mono text-xs text-neutral-500">
                  {f.match}
                </pre>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}