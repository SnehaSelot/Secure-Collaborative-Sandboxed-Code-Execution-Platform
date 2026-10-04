import { beforeEach, describe, expect, it } from 'vitest';
import { useExecutionStore } from './executionStore';

describe('execution output preferences', () => {
  beforeEach(() => {
    useExecutionStore.setState({
      isRunning: false,
      result: null,
      error: null,
      lastCode: null,
      lastLanguage: null,
      stdin: '',
      terminalLines: [],
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  });

  it('retains previous terminal lines when the run preference requests it', () => {
    const store = useExecutionStore.getState();
    store.addTerminalLine('output', 'previous output');
    useExecutionStore.getState().startExecution('print(1)', 'python', true);

    expect(useExecutionStore.getState().terminalLines).toEqual([
      { type: 'output', text: 'previous output' },
    ]);
  });

  it('clears previous terminal lines by default', () => {
    const store = useExecutionStore.getState();
    store.addTerminalLine('output', 'previous output');
    useExecutionStore.getState().startExecution('print(1)', 'python');

    expect(useExecutionStore.getState().terminalLines).toEqual([]);
  });
});
