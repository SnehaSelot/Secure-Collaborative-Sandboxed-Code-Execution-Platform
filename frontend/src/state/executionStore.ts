import { create } from 'zustand';
import type { ExecuteResponse } from '../api/types';

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

  startExecution: (code: string, language: string) => void;
  setResult: (result: ExecuteResponse) => void;
  setError: (error: string) => void;
  resetExecution: () => void;
}

export const useExecutionStore = create<ExecutionState>((set) => ({
  isRunning: false,
  result: null,
  error: null,
  lastCode: null,
  lastLanguage: null,

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
}));