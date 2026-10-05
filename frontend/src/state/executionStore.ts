import { create } from 'zustand';
import type { ExecuteResponse } from '../api/types';

interface TerminalLine {
  type: 'output' | 'input' | 'error' | 'info';
  text: string;
}

interface ExecutionState {
  isRunning: boolean;
  result: ExecuteResponse | null;
  error: string | null;
  lastCode: string | null;
  lastLanguage: string | null;
  /** Terminal's stdin field value. Sent once, upfront, by useStreamExecution's
   *  run() — the backend closes stdin (EOF) right after the container
   *  starts, so this can't be changed once isRunning is true. */
  stdin: string;
  /** Terminal history — lines of output/input/errors */
  terminalLines: TerminalLine[];
  /** Set by the /ws/execute stream when a stream hits the 20k-char cap. */
  stdoutTruncated: boolean;
  stderrTruncated: boolean;

  startExecution: (code: string, language: string, retainOutput?: boolean) => void;
  setResult: (result: ExecuteResponse) => void;
  setError: (error: string) => void;
  resetExecution: () => void;
  setStdin: (stdin: string) => void;
  addTerminalLine: (type: TerminalLine['type'], text: string) => void;
  clearTerminal: () => void;
  setTruncated: (which: 'stdout' | 'stderr') => void;
}

export const useExecutionStore = create<ExecutionState>((set) => ({
  isRunning: false,
  result: null,
  error: null,
  lastCode: null,
  lastLanguage: null,
  stdin: '',
  terminalLines: [],
  stdoutTruncated: false,
  stderrTruncated: false,

  startExecution: (code, language, retainOutput = false) =>
    set((state) => ({
      isRunning: true,
      error: null,
      result: null,
      lastCode: code,
      lastLanguage: language,
      terminalLines: retainOutput ? state.terminalLines : [],
      stdoutTruncated: false,
      stderrTruncated: false,
    })),

  setResult: (result) =>
    set({ isRunning: false, result, error: null }),

  setError: (error) =>
    set({ isRunning: false, error, result: null }),

  resetExecution: () =>
    set({ isRunning: false, result: null, error: null, lastCode: null, lastLanguage: null }),

  // Deliberately does not touch isRunning/result/error — this is just
  // the stdin field and should survive a run/Clear untouched.
  setStdin: (stdin) => set({ stdin }),

  addTerminalLine: (type, text) =>
    set((state) => ({ terminalLines: [...state.terminalLines, { type, text }] })),

  clearTerminal: () => set({ terminalLines: [] }),

  setTruncated: (which) =>
    set(which === 'stdout' ? { stdoutTruncated: true } : { stderrTruncated: true }),
}));