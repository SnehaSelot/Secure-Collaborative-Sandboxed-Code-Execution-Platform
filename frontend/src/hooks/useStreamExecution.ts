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
 */
export function useStreamExecution() {
  const startExecution = useExecutionStore((s) => s.startExecution);
  const setResult = useExecutionStore((s) => s.setResult);
  const setError = useExecutionStore((s) => s.setError);
  const addTerminalLine = useExecutionStore((s) => s.addTerminalLine);
  const setTruncated = useExecutionStore((s) => s.setTruncated);
  const isRunning = useExecutionStore((s) => s.isRunning);

  const cancelRef = useRef<(() => void) | null>(null);

  const run = useCallback(
    (code: string, language: string) => {
      if (!code.trim()) {
        setError('Code cannot be empty.');
        return;
      }

      cancelRef.current?.();
      startExecution(code, language);

      cancelRef.current = streamExecute(language, code, {
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
        onError: (message) => setError(message),
      });
    },
    [startExecution, setResult, setError, addTerminalLine, setTruncated],
  );

  const cancel = useCallback(() => {
    cancelRef.current?.();
    cancelRef.current = null;
  }, []);

  return { run, cancel, isRunning };
}