/**
 * state/collaborationStore.ts — Shared state for the active collaboration session.
 *
 * Allows other pages (such as RiskAnalysisPage) to discover and analyze files
 * from the active collaboration room alongside local workspace files.
 */

import { create } from 'zustand';
import {
  getCollabSession,
  listCollabFiles,
  type SessionResponse,
  type FileItemResponse,
} from '../api/collaborationApi';
import { extractErrorMessage } from '../api/client';

export interface ActiveCollabSession {
  session: SessionResponse;
  files: FileItemResponse[];
  activeFileId: string | null;
}

interface CollabStoreState {
  activeSession: SessionResponse | null;
  sessionFiles: FileItemResponse[];
  activeFileId: string | null;
  isLoading: boolean;
  sessionError: string | null;

  setActiveSession: (
    session: SessionResponse,
    files: FileItemResponse[],
    activeFileId?: string | null,
  ) => void;
  setSessionFiles: (files: FileItemResponse[]) => void;
  setActiveFileId: (fileId: string | null) => void;
  setSessionError: (error: string | null) => void;
  clearActiveSession: () => void;
  refreshSession: (sessionId: string, token: string) => Promise<void>;
}

export const useCollabStore = create<CollabStoreState>((set) => ({
  activeSession: null,
  sessionFiles: [],
  activeFileId: null,
  isLoading: false,
  sessionError: null,

  setActiveSession: (session, files, activeFileId = null) => {
    set({
      activeSession: session,
      sessionFiles: files,
      activeFileId,
      sessionError: null,
      isLoading: false,
    });
  },

  setSessionFiles: (files) => {
    set((state) => {
      const activeStillExists = files.some((f) => f.id === state.activeFileId);
      return {
        sessionFiles: files,
        activeFileId: activeStillExists ? state.activeFileId : (files[0]?.id ?? null),
      };
    });
  },

  setActiveFileId: (fileId) => set({ activeFileId: fileId }),

  setSessionError: (error) => set({ sessionError: error, isLoading: false }),

  clearActiveSession: () =>
    set({
      activeSession: null,
      sessionFiles: [],
      activeFileId: null,
      isLoading: false,
      sessionError: null,
    }),

  refreshSession: async (sessionId: string, token: string) => {
    set({ isLoading: true, sessionError: null });
    try {
      const session = await getCollabSession(sessionId, token);
      const files = await listCollabFiles(sessionId, token);
      set({
        activeSession: session,
        sessionFiles: files,
        activeFileId: files[0]?.id ?? null,
        isLoading: false,
        sessionError: null,
      });
    } catch (err) {
      const msg = extractErrorMessage(err);
      let friendlyMessage = msg;
      if (msg.includes('403') || msg.includes('Not a member')) {
        friendlyMessage = 'Access denied — you are not a member of this session.';
      } else if (msg.includes('404') || msg.includes('not found')) {
        friendlyMessage = 'Session not found. The room link may be invalid or expired.';
      } else if (msg.includes('409') || msg.includes('closed')) {
        friendlyMessage = 'This session is closed.';
      } else if (msg.includes('401') || msg.includes('authenticated')) {
        friendlyMessage = 'Authentication failed. Please sign in again.';
      }
      set({
        isLoading: false,
        sessionError: friendlyMessage,
      });
    }
  },
}));

// Listen for global collaboration exit events
if (typeof window !== 'undefined') {
  window.addEventListener('glasshouse:collaboration-exited', () => {
    useCollabStore.getState().clearActiveSession();
  });
}

