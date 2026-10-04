import { create } from 'zustand';
import type { ExecuteResponse } from '../api/types';

/**
 * Terminal line — either output from the program or input typed by the user.
 */
interface TerminalLine {
  type: 'output' | 'input' | 'error' | 'info';
  text: string;
}

/**
 * Execution state is global (not local component state) because the
 * Run button (EditorToolbar), the terminal display (OutputPanel), and the
 * status badge (ExecutionStatusBadge) all need to read/react to the same
 * in-flight run without prop-drilling through EditorPage.
 *
 * NOTE ON STDIN: there is intentionally no `stdin` field here. The
 * current /ws/execute protocol is one-shot — client sends
 * { language, code } once, server streams stdout/stderr/result back —
 * there is no channel for the client to send more messages once
 * execution has started. See the TODO in api/streamExecution.ts for
 * what a future bidirectional protocol needs before stdin can be
 * added back in, at which point it belongs here as e.g.
 * `sendInput: (text: string) => void` backed by the same live socket.
 */
interface ExecutionState {
  isRunning: boolean;
  result: ExecuteResponse | null;
  error: string | null;
  lastCode: string | null;
  lastLanguage: string | null;
  /** Terminal history — lines of output/input/errors */
  terminalLines: TerminalLine[];
  /** Set by the /ws/execute stream when a stream hits the 20k-char cap. */
  stdoutTruncated: boolean;
  stderrTruncated: boolean;

  startExecution: (code: string, language: string) => void;
  setResult: (result: ExecuteResponse) => void;
  setError: (error: string) => void;
  resetExecution: () => void;
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
  terminalLines: [],
  stdoutTruncated: false,
  stderrTruncated: false,

  startExecution: (code, language) =>
    set({
      isRunning: true,
      error: null,
      result: null,
      lastCode: code,
      lastLanguage: language,
      terminalLines: [],
      stdoutTruncated: false,
      stderrTruncated: false,
    }),

  setResult: (result) =>
    set({
      isRunning: false,
      result,
      error: null,
    }),

  setError: (error) =>
    set({
      isRunning: false,
      error,
      result: null,
    }),

  resetExecution: () =>
    set({
      isRunning: false,
      result: null,
      error: null,
      lastCode: null,
      lastLanguage: null,
    }),

  addTerminalLine: (type, text) =>
    set((state) => ({
      terminalLines: [...state.terminalLines, { type, text }],
    })),

  clearTerminal: () =>
    set({ terminalLines: [] }),

  setTruncated: (which) =>
    set(which === 'stdout' ? { stdoutTruncated: true } : { stderrTruncated: true }),
}));