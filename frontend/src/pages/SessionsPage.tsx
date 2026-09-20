import { useState } from 'react';
import { useSessionsStore } from '../state/sessionsStore';
import { useWorkspaceStore } from '../state/workspaceStore';

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}

/**
 * Local-only workspace snapshots. Explicitly NOT multi-user session
 * sharing/joining — that needs a backend workspace service (see
 * state/sessionsStore.ts's header comment). Labeled clearly so this
 * doesn't read as more than it is, same pattern as RiskAnalysisPage.
 */
export function SessionsPage() {
  const sessions = useSessionsStore((s) => s.sessions);
  const saveSession = useSessionsStore((s) => s.saveSession);
  const restoreSession = useSessionsStore((s) => s.restoreSession);
  const deleteSession = useSessionsStore((s) => s.deleteSession);

  const fileCount = useWorkspaceStore((s) => Object.keys(s.nodes).length);

  const [name, setName] = useState('');

  const handleSave = () => {
    const trimmed = name.trim() || `Session ${new Date().toLocaleString()}`;
    saveSession(trimmed);
    setName('');
  };

  const handleRestore = (id: string, sessionName: string) => {
    const confirmed = window.confirm(
      `Restore "${sessionName}"? This replaces your current workspace (${fileCount} file${fileCount === 1 ? '' : 's'}) — save it first if you want to keep it.`,
    );
    if (confirmed) restoreSession(id);
  };

  const handleDelete = (id: string, sessionName: string) => {
    if (window.confirm(`Delete "${sessionName}"? This can't be undone.`)) {
      deleteSession(id);
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div>
        <h1 className="text-lg font-semibold text-neutral-100">Sessions</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Local snapshots of your workspace, saved in this browser. Not shared with anyone —
          multi-user session joining will need a backend workspace service.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-neutral-900/60 p-4">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSave()}
          placeholder="Session name (optional)"
          className="min-w-0 flex-1 rounded-md border border-white/10 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-200 outline-none placeholder:text-neutral-600"
        />
        <button
          type="button"
          onClick={handleSave}
          className="shrink-0 rounded-md bg-emerald-500 px-4 py-1.5 text-sm font-medium text-neutral-950 transition hover:bg-emerald-400"
        >
          Save current workspace
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-white/10 bg-neutral-900/60 p-4">
        {sessions.length === 0 ? (
          <p className="text-sm text-neutral-600">
            No saved sessions yet. Save your current workspace above to create one.
          </p>
        ) : (
          <ul className="space-y-2">
            {sessions.map((session) => (
              <li
                key={session.id}
                className="flex items-center justify-between gap-3 rounded-md border border-white/10 bg-neutral-950/60 p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-neutral-100">{session.name}</p>
                  <p className="text-xs text-neutral-500">
                    {formatTimestamp(session.createdAt)} ·{' '}
                    {Object.keys(session.nodes).length} file
                    {Object.keys(session.nodes).length === 1 ? '' : 's'}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => handleRestore(session.id, session.name)}
                    className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-neutral-300 transition hover:bg-white/5 hover:text-neutral-100"
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(session.id, session.name)}
                    className="rounded-md border border-red-500/20 px-3 py-1.5 text-xs text-red-400 transition hover:bg-red-500/10"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}