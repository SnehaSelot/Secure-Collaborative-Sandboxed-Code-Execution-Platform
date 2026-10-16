import { create } from 'zustand';
import { useWorkspaceStore, type FileSystemNode } from './workspaceStore';

/** Browser-local snapshots are private to the authenticated account that saved them. */
export interface WorkspaceSession {
  id: string;
  name: string;
  createdAt: number;
  nodes: Record<string, FileSystemNode>;
  activeFileId: string | null;
}

interface SessionsState {
  sessions: WorkspaceSession[];
  accountId: string | null;
  activateAccount: (accountId: string | null) => void;
  clearActiveAccount: () => void;
  saveSession: (name: string) => void;
  restoreSession: (id: string) => void;
  deleteSession: (id: string) => void;
}

const storageKey = (accountId: string) => `glasshouse-sessions:${encodeURIComponent(accountId)}`;

function readSessions(accountId: string | null): WorkspaceSession[] {
  if (!accountId) return [];
  try {
    const stored = localStorage.getItem(storageKey(accountId));
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is WorkspaceSession =>
      typeof item === 'object' && item !== null &&
      typeof item.id === 'string' && typeof item.name === 'string' &&
      typeof item.createdAt === 'number' && typeof item.nodes === 'object' && item.nodes !== null &&
      (item.activeFileId === null || typeof item.activeFileId === 'string'),
    );
  } catch {
    return [];
  }
}

function persistSessions(accountId: string | null, sessions: WorkspaceSession[]) {
  if (!accountId) return;
  try {
    localStorage.setItem(storageKey(accountId), JSON.stringify(sessions));
  } catch {
    // Keep the in-memory session usable when browser storage is unavailable.
  }
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  accountId: null,

  activateAccount: (accountId) => {
    if (get().accountId === accountId) return;
    set({ accountId, sessions: readSessions(accountId) });
  },

  clearActiveAccount: () => set({ accountId: null, sessions: [] }),

  saveSession: (name) => {
    const accountId = get().accountId;
    if (!accountId) return;
    const { nodes, activeFileId } = useWorkspaceStore.getState();
    const session: WorkspaceSession = {
      id: crypto.randomUUID(),
      name,
      createdAt: Date.now(),
      nodes: structuredClone(nodes),
      activeFileId,
    };
    const sessions = [session, ...get().sessions];
    persistSessions(accountId, sessions);
    set({ sessions });
  },

  restoreSession: (id) => {
    const session = get().sessions.find((item) => item.id === id);
    if (!session) return;
    useWorkspaceStore.setState({
      nodes: structuredClone(session.nodes),
      activeFileId: session.activeFileId,
    });
  },

  deleteSession: (id) => {
    const accountId = get().accountId;
    const sessions = get().sessions.filter((session) => session.id !== id);
    persistSessions(accountId, sessions);
    set({ sessions });
  },
}));

if (typeof window !== 'undefined') {
  window.addEventListener('glasshouse:account-logged-out', () => {
    useSessionsStore.getState().clearActiveAccount();
  });
}
