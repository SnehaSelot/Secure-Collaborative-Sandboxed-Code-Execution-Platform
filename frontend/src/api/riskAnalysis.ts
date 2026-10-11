/**
 * api/riskAnalysis.ts — Typed client for the backend risk-analysis endpoint.
 *
 * Endpoint: POST /risk/analyze
 * Auth:     Bearer token (from authStore when available, or unauthenticated)
 * Docs:     artifacts/FRONTEND_RISK_INTEGRATION.md §2
 *
 * NOTE: The /risk/analyze endpoint always returns 200 OK even when the verdict
 * is "block" — a block decision is a normal analysis result here (the user
 * asked for analysis, not execution). A 403 only appears on POST /execute when
 * the engine blocks runtime submission.
 */

import { apiClient } from './client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RiskDecision = 'allow' | 'flag' | 'block';
export type RiskSeverity = 'critical' | 'high' | 'medium' | 'low';
export type RiskSource = 'rule' | 'ml' | 'ast';

export interface RiskFinding {
  /** e.g. "py.net_fetch", "common.shadow", "ml.python_classifier" */
  rule_code: string;
  /** Where the finding came from */
  source: RiskSource;
  /** e.g. "network", "execution", "credential_access", "destruction" */
  category: string;
  severity: RiskSeverity;
  /** Rule weight or model probability (0.0–1.0), null for some rule-based findings */
  confidence: number | null;
  /** 1-based start line; null for file-level ML findings */
  line_start: number | null;
  /** 1-based end line; null for file-level ML findings */
  line_end: number | null;
  /** Human-readable explanation */
  message: string;
  /** Code excerpt where pattern was detected; null for ML findings */
  snippet: string | null;
}

export interface RiskThresholds {
  flag: number;
  block: number;
}

export interface RiskAnalysisResponse {
  /** High-level policy verdict */
  decision: RiskDecision;
  /** Composite risk score, 0–100 */
  score: number;
  /** Active decision thresholds */
  thresholds: RiskThresholds;
  findings: RiskFinding[];
  /** Engine mode: "rules" or "rules+ml" */
  model: string;
  /** ML model probability scaled 0–100; null when ML not used */
  ml_score: number | null;
  /** Reason ML was skipped (e.g. "unsupported language"); null when ML ran */
  fallback_reason: string | null;
  /** Analysis wall-clock time in milliseconds */
  latency_ms: number;
  /** Stable ID for this assessment (for correlation with backend logs) */
  assessment_id: string | null;
  /** True if input exceeded 400 000 characters — tail was not scanned */
  truncated: boolean;
  /** Set when the risk engine itself errored (but returned gracefully) */
  error: string | null;
  /** Extra reason field present on engine-error responses */
  reason: string | null;
}

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

/**
 * Analyze code for security risks via the backend ML + rule engine.
 *
 * @param language  Language identifier (e.g. "python", "javascript")
 * @param code      Source code to analyze (max 1 000 000 chars accepted by backend)
 * @param token     Optional Bearer token — required by the backend (401 if missing)
 */
export async function analyzeCodeRisk(
  language: string,
  code: string,
  token?: string,
): Promise<RiskAnalysisResponse> {
  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const { data } = await apiClient.post<RiskAnalysisResponse>(
    '/risk/analyze',
    { language, code },
    { headers },
  );
  return data;
}

