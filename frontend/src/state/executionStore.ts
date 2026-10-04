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
 * Run button (EditorToolbar), the output display (OutputPanel), and the
 * status badge (ExecutionStatusBadge) all need to read/react to the same
 * in-flight run without prop-drilling through EditorPage.
 *
 * Per project convention, this store holds ONLY execution state — UI
 * state that doesn't need to be shared (e.g. "is the settings dropdown
 * open") stays as local useState in whatever component owns it.
 */
interface ExecutionState {
  isRunning: boolean;
  result: ExecuteResponse | null;
  error: string | null;
  lastCode: string | null;
  lastLanguage: string | null;
  /** The stdin textarea's current value — lives here (not local state)
   *  so useExecuteCode.ts can read it without prop-drilling from
   *  EditorPage.tsx down into StdinInput.tsx. */
  stdin: string;
  /** Terminal history — lines of output/input/errors */
  terminalLines: TerminalLine[];

  startExecution: (code: string, language: string) => void;
  setResult: (result: ExecuteResponse) => void;
  setError: (error: string) => void;
  resetExecution: () => void;
  setStdin: (stdin: string) => void;
  addTerminalLine: (type: TerminalLine['type'], text: string) => void;
  clearTerminal: () => void;
}

export const useExecutionStore = create<ExecutionState>((set) => ({
  isRunning: false,
  result: null,
  error: null,
  lastCode: null,
  lastLanguage: null,
  stdin: '',
  terminalLines: [],

  startExecution: (code, language) =>
    set({
      isRunning: true,
      error: null,
      result: null,
      lastCode: code,
      lastLanguage: language,
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

  // Deliberately does NOT touch isRunning/result/error/lastCode/lastLanguage
  // — resetExecution() is for clearing a run's outcome; this is just the
  // input box, and should survive a Clear/re-run untouched.
  setStdin: (stdin) => set({ stdin }),

  addTerminalLine: (type, text) =>
    set((state) => ({
      terminalLines: [...state.terminalLines, { type, text }],
    })),

  clearTerminal: () =>
    set({ terminalLines: [] }),
}));