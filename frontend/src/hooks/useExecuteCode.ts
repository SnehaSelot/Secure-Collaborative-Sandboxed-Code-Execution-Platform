import { useCallback } from 'react';
import { executeCode } from '../api/execution';
import { extractErrorMessage } from '../api/client';
import { useExecutionStore } from '../state/executionStore';

/**
 * BACKEND INTEGRATION:
 * Endpoint: POST /execute
 * Status: Available
 * Request: { language: string, code: string }
 * Response: { stdout, stderr, exit_code, status, execution_time }
 * TODO: Keep this function isolated so the endpoint can be changed later.
 *
 * Never writes a fake success result on failure — a thrown/caught error
 * always goes to setError, never to setResult, so the UI can't display
 * a fabricated "success" for a run that never actually happened.
 */
export function useExecuteCode() {
  const startExecution = useExecutionStore((s) => s.startExecution);
  const setResult = useExecutionStore((s) => s.setResult);
  const setError = useExecutionStore((s) => s.setError);
  const isRunning = useExecutionStore((s) => s.isRunning);

  const run = useCallback(
    async (code: string, language: string) => {
      if (!code.trim()) {
        setError('Code cannot be empty.');
        return;
      }

      startExecution(code, language);

      try {
        const result = await executeCode({ code, language });
        setResult(result);
      } catch (err) {
        setError(extractErrorMessage(err));
      }
    },
    [startExecution, setResult, setError],
  );

  return { run, isRunning };
}