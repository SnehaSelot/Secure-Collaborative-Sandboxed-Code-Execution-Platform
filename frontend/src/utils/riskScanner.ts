export type RiskSeverity = 'high' | 'medium' | 'low';

export interface RiskFinding {
  severity: RiskSeverity;
  title: string;
  description: string;
  /** 1-based line number where the pattern first matched, if found. */
  line?: number;
  /** The exact text that matched, shown so the user can locate it. */
  match: string;
}

interface RiskRule {
  pattern: RegExp;
  severity: RiskSeverity;
  title: string;
  description: string;
}

/**
 * BACKEND INTEGRATION (future):
 * This is a client-side, regex-based heuristic scanner — it has no
 * understanding of the code, just pattern matching, and will both miss
 * real issues and flag safe code that happens to match a pattern. It
 * exists so the Risk Analysis page (currently a placeholder) shows
 * something real today instead of nothing.
 *
 * The actual planned feature (per AppRoutes.tsx's /risk description)
 * is an AI risk-analysis SERVICE — a backend endpoint, e.g.
 * POST /risk/analyze { language, code } -> { findings }, presumably
 * backed by an LLM or a proper static-analysis tool (bandit for
 * Python, semgrep across languages, etc.) that actually understands
 * control flow. When that ships:
 *   1. Add api/riskAnalysis.ts calling it (same shape as api/execution.ts).
 *   2. Add a hook (useRiskAnalysis.ts) that calls the endpoint.
 *   3. Swap analyzeRiskHeuristic() below for that hook in
 *      pages/RiskAnalysisPage.tsx — keep this function around as an
 *      instant client-side pass shown while the backend call is in
 *      flight, rather than deleting it.
 */

const GENERIC_RULES: RiskRule[] = [
  {
    pattern: /(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["'][^"']{4,}["']/i,
    severity: 'high',
    title: 'Hardcoded credential',
    description: 'A secret-looking value is hardcoded in source rather than read from config/env.',
  },
  {
    pattern: /https?:\/\/[^\s"'`]+/i,
    severity: 'low',
    title: 'Hardcoded network endpoint',
    description: 'A URL is hardcoded in source. Not inherently unsafe, but worth reviewing for SSRF-style risk if it comes from user input elsewhere.',
  },
];

const RULES_BY_LANGUAGE: Record<string, RiskRule[]> = {
  python: [
    { pattern: /\beval\s*\(/, severity: 'high', title: 'eval()', description: 'Executes arbitrary code from a string at runtime.' },
    { pattern: /\bexec\s*\(/, severity: 'high', title: 'exec()', description: 'Executes arbitrary code from a string at runtime.' },
    { pattern: /\bos\.system\s*\(/, severity: 'high', title: 'os.system()', description: 'Runs a shell command; unsafe if any part of it comes from user input.' },
    { pattern: /subprocess\.\w+\([^)]*shell\s*=\s*True/, severity: 'high', title: 'subprocess(..., shell=True)', description: 'Runs a command through the shell, enabling shell-injection if the command is built from untrusted input.' },
    { pattern: /\bpickle\.loads?\s*\(/, severity: 'high', title: 'pickle.load(s)', description: 'Deserializing untrusted pickle data can execute arbitrary code.' },
    { pattern: /\b__import__\s*\(/, severity: 'medium', title: '__import__()', description: 'Dynamic import of a module name; risky if the name comes from user input.' },
    { pattern: /\bshutil\.rmtree\s*\(/, severity: 'medium', title: 'shutil.rmtree()', description: 'Recursively deletes a directory tree; verify the path is not user-controlled.' },
  ],
  javascript: [
    { pattern: /\beval\s*\(/, severity: 'high', title: 'eval()', description: 'Executes arbitrary code from a string at runtime.' },
    { pattern: /new\s+Function\s*\(/, severity: 'high', title: 'new Function()', description: 'Compiles and runs a string as code, similar to eval().' },
    { pattern: /child_process\.\w*exec\w*\s*\(/, severity: 'high', title: 'child_process.exec()', description: 'Runs a shell command; unsafe if any part of it comes from user input.' },
    { pattern: /\.innerHTML\s*=/, severity: 'medium', title: 'innerHTML assignment', description: 'Assigning untrusted content to innerHTML can lead to XSS.' },
  ],
  java: [
    { pattern: /Runtime\.getRuntime\(\)\.exec\s*\(/, severity: 'high', title: 'Runtime.exec()', description: 'Runs an OS command; unsafe if any part of it comes from user input.' },
    { pattern: /ProcessBuilder\s*\(/, severity: 'medium', title: 'ProcessBuilder', description: 'Spawns an OS process; verify arguments aren\u2019t built from untrusted input.' },
    { pattern: /ObjectInputStream\s*\(/, severity: 'high', title: 'ObjectInputStream', description: 'Deserializing untrusted Java objects can lead to remote code execution.' },
  ],
  c: [
    { pattern: /\bsystem\s*\(/, severity: 'high', title: 'system()', description: 'Runs a shell command; unsafe if any part of it comes from user input.' },
    { pattern: /\bstrcpy\s*\(|\bstrcat\s*\(|\bsprintf\s*\(/, severity: 'high', title: 'Unbounded string function', description: 'strcpy/strcat/sprintf don\u2019t bound-check and are a classic buffer-overflow source; prefer the *_s or n-prefixed variants.' },
    { pattern: /\bgets\s*\(/, severity: 'high', title: 'gets()', description: 'Reads unbounded input into a fixed buffer; always a buffer-overflow risk.' },
  ],
  cpp: [
    { pattern: /\bsystem\s*\(/, severity: 'high', title: 'system()', description: 'Runs a shell command; unsafe if any part of it comes from user input.' },
    { pattern: /\bstrcpy\s*\(|\bstrcat\s*\(|\bsprintf\s*\(/, severity: 'high', title: 'Unbounded string function', description: 'strcpy/strcat/sprintf don\u2019t bound-check and are a classic buffer-overflow source.' },
    { pattern: /\breinterpret_cast\s*</, severity: 'low', title: 'reinterpret_cast', description: 'Bypasses the type system; verify the cast is actually sound.' },
  ],
  go: [
    { pattern: /exec\.Command\s*\(/, severity: 'medium', title: 'exec.Command()', description: 'Spawns an OS process; verify arguments aren\u2019t built from untrusted input.' },
    { pattern: /os\.RemoveAll\s*\(/, severity: 'medium', title: 'os.RemoveAll()', description: 'Recursively deletes a path; verify the path is not user-controlled.' },
  ],
  rust: [
    { pattern: /\bunsafe\s*\{/, severity: 'medium', title: 'unsafe block', description: 'Opts out of Rust\u2019s memory-safety guarantees within this block.' },
    { pattern: /std::process::Command::new\s*\(/, severity: 'medium', title: 'Command::new()', description: 'Spawns an OS process; verify arguments aren\u2019t built from untrusted input.' },
  ],
};

function lineOf(code: string, index: number): number {
  return code.slice(0, index).split('\n').length;
}

export function analyzeRiskHeuristic(code: string, language: string): RiskFinding[] {
  const rules = [...(RULES_BY_LANGUAGE[language] ?? []), ...GENERIC_RULES];
  const findings: RiskFinding[] = [];

  for (const rule of rules) {
    const match = rule.pattern.exec(code);
    if (match) {
      findings.push({
        severity: rule.severity,
        title: rule.title,
        description: rule.description,
        line: lineOf(code, match.index),
        match: match[0],
      });
    }
  }

  // High severity first, then medium, then low.
  const order: Record<RiskSeverity, number> = { high: 0, medium: 1, low: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}