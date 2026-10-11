import { useCallback, useRef } from 'react';
import { streamExecute } from '../api/streamExecution';
import { useExecutionStore } from '../state/executionStore';

/**
 * BACKEND INTEGRATION:
 * Endpoint: WS /ws/execute
 * Status: Available
 *
 * This is the Run action used by EditorPage.tsx. useExecuteCode.ts
 * (POST /execute) is kept around unused as a fallback.
 *
 * stdin is read from executionStore (filled in by the Terminal's stdin
 * field — see OutputPanel.tsx) and sent once, upfront. See the TODO in
 * api/streamExecution.ts for what live/mid-run stdin would need.
 *
 * Risk gate integration:
 *   - onRiskWarning: the backend flagged the code but allowed execution.
 *     Adds a "risk" terminal line and stores the payload in riskWarning.
 *   - onError with reason="blocked": the backend blocked execution.
 *     Stores the payload in blockedByRisk so OutputPanel can render details.
 */
export function useStreamExecution() {
  const startExecution = useExecutionStore((s) => s.startExecution);
  const setResult = useExecutionStore((s) => s.setResult);
  const setError = useExecutionStore((s) => s.setError);
  const setBlockedByRisk = useExecutionStore((s) => s.setBlockedByRisk);
  const setRiskWarning = useExecutionStore((s) => s.setRiskWarning);
  const resetExecution = useExecutionStore((s) => s.resetExecution);
  const addTerminalLine = useExecutionStore((s) => s.addTerminalLine);
  const setTruncated = useExecutionStore((s) => s.setTruncated);
  const isRunning = useExecutionStore((s) => s.isRunning);

  const cancelRef = useRef<(() => void) | null>(null);

  const run = useCallback(
    (code: string, language: string, stdin = '', retainOutput = false) => {
      if (!code.trim()) {
        setError('Code cannot be empty.');
        return;
      }

      cancelRef.current?.();
      startExecution(code, language, retainOutput);

      cancelRef.current = streamExecute(language, code, stdin, {
        onStdout: (chunk) => addTerminalLine('output', chunk),
        onStderr: (chunk) => addTerminalLine('error', chunk),
        onStdoutTruncated: () => setTruncated('stdout'),
        onStderrTruncated: () => setTruncated('stderr'),
        onResult: (result) =>
          setResult({
            stdout: '',
            stderr: '',
            exit_code: result.exit_code,
            status: result.status,
            execution_time: result.execution_time,
          }),
        onError: (message, reason, risk) => {
          if (reason === 'blocked' && risk) {
            // Execution was blocked by the risk gate — store the risk payload
            // so OutputPanel can show detailed findings.
            setBlockedByRisk(risk);
          } else {
            setError(message);
          }
        },
        onRiskWarning: (risk) => {
          // Code was flagged but execution continues — surface a visible warning.
          setRiskWarning(risk);
          const score = risk.score ?? '?';
          const count = risk.findings?.length ?? 0;
          addTerminalLine(
            'risk',
            `⚠ Risk warning: score ${score}/100 — ${count} finding${count !== 1 ? 's' : ''} (execution allowed)`,
          );
        },
      });
    },
    [startExecution, setResult, setError, setBlockedByRisk, setRiskWarning, addTerminalLine, setTruncated],
  );

  const cancel = useCallback(() => {
    cancelRef.current?.();
    cancelRef.current = null;
    resetExecution();
  }, [resetExecution]);

  return { run, cancel, isRunning };
}