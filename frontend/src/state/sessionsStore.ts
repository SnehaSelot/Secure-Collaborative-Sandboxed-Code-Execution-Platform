import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useWorkspaceStore, type FileSystemNode } from './workspaceStore';

/**
 * "Sessions" here means LOCAL, single-browser snapshots of the workspace
 * you can save and come back to — not multi-user collaboration. Real
 * session sharing/joining (per the original /sessions ComingSoonPage
 * copy) needs a backend workspace service; this is the honest subset
 * that's actually implementable client-only, same spirit as
 * riskScanner.ts being a heuristic stand-in for the real AI service.
 */
export interface WorkspaceSession {
  id: string;
  name: string;
  createdAt: number;
  nodes: Record<string, FileSystemNode>;
  activeFileId: string | null;
}

interface SessionsState {
  sessions: WorkspaceSession[];
  saveSession: (name: string) => void;
  restoreSession: (id: string) => void;
  deleteSession: (id: string) => void;
}

export const useSessionsStore = create<SessionsState>()(
  persist(
    (set, get) => ({
      sessions: [],

      saveSession: (name) => {
        const { nodes, activeFileId } = useWorkspaceStore.getState();
        const session: WorkspaceSession = {
          id: crypto.randomUUID(),
          name,
          createdAt: Date.now(),
          // Structural clone so later edits to the live workspace can't
          // mutate a saved snapshot.
          nodes: structuredClone(nodes),
          activeFileId,
        };
        set({ sessions: [session, ...get().sessions] });
      },

      restoreSession: (id) => {
        const session = get().sessions.find((s) => s.id === id);
        if (!session) return;
        // Bypasses workspaceStore's own actions on purpose — this is a
        // full state replacement, not an incremental edit, and
        // workspaceStore.setState (from Zustand) is what persist's own
        // rehydration uses too.
        useWorkspaceStore.setState({
          nodes: structuredClone(session.nodes),
          activeFileId: session.activeFileId,
        });
      },

      deleteSession: (id) => {
        set({ sessions: get().sessions.filter((s) => s.id !== id) });
      },
    }),
    { name: 'glasshouse-sessions' },
  ),
);