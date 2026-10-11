/**
 * pages/CollaborationPage.tsx — Real-time collaboration page.
 *
 * F4: Implements /collaboration/:roomId routing with real room join/create.
 * F5: Uses backend session/file APIs to get canonical IDs.
 * F7: Shows connection status, errors, retry/recovery options.
 *
 * A "room" on the frontend maps to a "{sessionId}:{fileId}" pair on the backend.
 * Users sharing the same URL join the same backend session and Yjs document.
 *
 * Flow:
 *  1. Unauthenticated → show Login / Signup form
 *  2. Authenticated, no roomId → show Create Room / Join Room UI
 *  3. Authenticated, valid roomId → join session, list files, open editor
 */

import { useState, useCallback, useEffect, useRef, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuthStore } from '../state/authStore';
import { useWorkspaceStore } from '../state/workspaceStore';
import {
  createCollabSession,
  getCollabSession,
  joinCollabSession,
  leaveCollabSession,
  createCollabFile,
  getCollabFile,
  listCollabFiles,
  renameCollabFile,
  deleteCollabFile,
  type SessionResponse,
  type FileItemResponse,
} from '../api/collaborationApi';
import { isValidRoomId } from '../collaboration/session';
import { extractErrorMessage } from '../api/client';
import { CodeEditor } from '../features/editor/CodeEditor';
import { ParticipantPresence } from '../features/editor/ParticipantPresence';
import { LanguageSelector } from '../features/editor/LanguageSelector';
import { EditorToolbar } from '../features/editor/EditorToolbar';
import { OutputPanel } from '../features/execution/OutputPanel';
import { useStreamExecution } from '../hooks/useStreamExecution';
import { useExecutionStore } from '../state/executionStore';
import { getFileDocumentContent, setFileDocumentContent } from '../state/fileDocumentRegistry';
import { detectLanguageFromFilename, getLanguageTemplate } from '../config/languageTemplates';
import { FALLBACK_LANGUAGES } from '../config/constants';
import { formatCode, isFormattable } from '../utils/formatCode';
import type { ProviderSnapshot } from '../collaboration/provider';
import type { CollabContext } from '../state/fileDocumentRegistry';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CollabRoom {
  session: SessionResponse;
  files: FileItemResponse[];
}

type PageState =
  | { phase: 'idle' }
  | { phase: 'loading'; message: string }
  | { phase: 'error'; message: string; retryable: boolean }
  | { phase: 'joined'; room: CollabRoom; activeFileId: string };

// ---------------------------------------------------------------------------
// Auth forms (login / signup)
// ---------------------------------------------------------------------------

function AuthSection({ onSuccess }: { onSuccess: () => void }) {
  const { login, signup, isLoading, error } = useAuthStore();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    try {
      if (mode === 'login') {
        await login(email, password);
      } else {
        await signup(email, displayName, password);
        // After signup, log in automatically
        await login(email, password);
      }
      onSuccess();
    } catch (err) {
      setLocalError(extractErrorMessage(err));
    }
  };

  return (
    <div className="mx-auto w-full max-w-sm rounded-lg border border-white/10 bg-neutral-900/60 p-6">
      <h2 className="mb-4 text-sm font-semibold text-neutral-200">
        {mode === 'login' ? 'Sign in to collaborate' : 'Create an account'}
      </h2>
      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
        {mode === 'signup' && (
          <input
            type="text"
            placeholder="Display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            className="rounded-md border border-white/10 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-emerald-500/50"
          />
        )}
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="rounded-md border border-white/10 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-emerald-500/50"
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          className="rounded-md border border-white/10 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-emerald-500/50"
        />
        {(localError ?? error) && (
          <p className="text-xs text-red-400" role="alert">{localError ?? error}</p>
        )}
        <button
          type="submit"
          disabled={isLoading}
          className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-neutral-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isLoading ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
      </form>
      <button
        type="button"
        onClick={() => {
          setMode(mode === 'login' ? 'signup' : 'login');
          setLocalError(null);
        }}
        className="mt-3 w-full text-center text-xs text-neutral-500 hover:text-neutral-300"
      >
        {mode === 'login' ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function CollaborationPage() {
  const { roomId: routeRoomId } = useParams<{ roomId?: string }>();
  const navigate = useNavigate();

  const user = useAuthStore((s) => s.user);
  const activeFileId = useWorkspaceStore((s) => s.activeFileId);
  const nodes = useWorkspaceStore((s) => s.nodes);

  const [pageState, setPageState] = useState<PageState>({ phase: 'idle' });
  const [enteredRoomId, setEnteredRoomId] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [exitMessage, setExitMessage] = useState<string | null>(null);
  const [providerSnapshot, setProviderSnapshot] = useState<ProviderSnapshot | null>(null);
  const [fileDialog, setFileDialog] = useState<null | 'create' | 'rename'>(null);
  const [filePathDraft, setFilePathDraft] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileToDelete, setFileToDelete] = useState<FileItemResponse | null>(null);
  const [isDeletingFile, setIsDeletingFile] = useState(false);
  const [deleteFileError, setDeleteFileError] = useState<string | null>(null);
  const [runLanguage, setRunLanguage] = useState('python');
  const [showSidebar, setShowSidebar] = useState(true);
  const [showTerminal, setShowTerminal] = useState(true);
  const [layout, setLayout] = useState<'horizontal' | 'vertical'>('horizontal');
  const [panelSize, setPanelSize] = useState(62);
  const [isDragging, setIsDragging] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const exitStartedRef = useRef(false);
  const editorTerminalRef = useRef<HTMLDivElement>(null);
  const joinRequestRef = useRef(0);
  const { run, cancel, isRunning } = useStreamExecution();
  const addTerminalLine = useExecutionStore((s) => s.addTerminalLine);

  useEffect(() => {
    if (!isDragging) return;
    const resizePanels = (event: MouseEvent) => {
      const container = editorTerminalRef.current;
      if (!container) return;
      const bounds = container.getBoundingClientRect();
      const nextSize = layout === 'horizontal'
        ? ((event.clientY - bounds.top) / bounds.height) * 100
        : ((event.clientX - bounds.left) / bounds.width) * 100;
      if (nextSize >= 20 && nextSize <= 80) setPanelSize(nextSize);
    };
    const stopDragging = () => setIsDragging(false);
    document.addEventListener('mousemove', resizePanels);
    document.addEventListener('mouseup', stopDragging);
    return () => {
      document.removeEventListener('mousemove', resizePanels);
      document.removeEventListener('mouseup', stopDragging);
    };
  }, [isDragging, layout]);

  // ---------------------------------------------------------------------------
  // Join an existing session by ID
  // ---------------------------------------------------------------------------

  const joinSession = useCallback(
    async (sessionId: string, token: string) => {
      const requestId = ++joinRequestRef.current;
      setPageState({ phase: 'loading', message: 'Joining collaboration session…' });
      try {
        // F5: Verify session exists and join it
        // The session GET is member-only, so add a valid signed-in visitor first.
        await joinCollabSession(sessionId, token);
        const session = await getCollabSession(sessionId, token);
        if (requestId !== joinRequestRef.current) return;
        if (session.status === 'closed') {
          setPageState({
            phase: 'error',
            message: 'This collaboration session is closed.',
            retryable: false,
          });
          return;
        }

        // F5: List files in the session
        let files = await listCollabFiles(sessionId, token);
        if (requestId !== joinRequestRef.current) return;

        // If no files exist, create a default one
        if (files.length === 0) {
          const activeFile = activeFileId ? nodes[activeFileId] : null;
          const defaultLanguage = activeFile?.language && (FALLBACK_LANGUAGES as readonly string[]).includes(activeFile.language)
            ? activeFile.language
            : 'python';
          const defaultFile = await createCollabFile(
            sessionId,
            activeFile?.name ?? 'main.py',
            defaultLanguage,
            activeFile?.content ?? getLanguageTemplate(defaultLanguage),
            token,
          );
          files = [defaultFile];
        }

        const firstDetail = await getCollabFile(sessionId, files[0].id, token);
        if (requestId !== joinRequestRef.current) return;
        files[0] = { ...files[0], content: firstDetail.content };
        setPageState({
          phase: 'joined',
          room: { session, files },
          activeFileId: files[0].id,
        });
      } catch (error) {
        if (requestId !== joinRequestRef.current) return;
        const message = extractErrorMessage(error);
        // F7: Map specific errors to helpful messages
        let friendlyMessage = message;
        if (message.includes('403') || message.includes('Not a member')) {
          friendlyMessage = 'Access denied — you are not a member of this session.';
        } else if (message.includes('404') || message.includes('not found')) {
          friendlyMessage = 'Session not found. The room link may be invalid or expired.';
        } else if (message.includes('409') || message.includes('closed')) {
          friendlyMessage = 'This session is closed and cannot be joined.';
        } else if (message.includes('401') || message.includes('authenticated')) {
          friendlyMessage = 'Authentication failed. Please sign in again.';
        }
        setPageState({ phase: 'error', message: friendlyMessage, retryable: true });
      }
    },
    [activeFileId, nodes],
  );

  // ---------------------------------------------------------------------------
  // Auto-join when navigating to /collaboration/:roomId
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!routeRoomId || !user || !isValidRoomId(routeRoomId)) return;
    if (pageState.phase === 'joined' && pageState.room.session.session_id === routeRoomId) return;
    if (pageState.phase === 'loading') return;

    const timer = setTimeout(() => {
      void joinSession(routeRoomId, user.token);
    }, 0);
    return () => clearTimeout(timer);
  }, [routeRoomId, user, joinSession, pageState.phase, pageState.phase === 'joined' ? pageState.room.session.session_id : null]);

  // File metadata changes are REST backed; refresh it so collaborators see
  // create, rename, and delete actions made by another participant.
  useEffect(() => {
    if (pageState.phase !== 'joined' || !user) return;
    const sessionId = pageState.room.session.session_id;
    const timer = window.setInterval(() => {
      void listCollabFiles(sessionId, user.token).then((files) => {
        setPageState((current) => {
          if (current.phase !== 'joined' || current.room.session.session_id !== sessionId) return current;
          const activeStillExists = files.some((file) => file.id === current.activeFileId);
          const mergedFiles = files.map((file) => ({ ...file, content: current.room.files.find((old) => old.id === file.id)?.content }));
          return { ...current, room: { ...current.room, files: mergedFiles }, activeFileId: activeStillExists ? current.activeFileId : files[0]?.id ?? '' };
        });
      }).catch(() => { /* transient polling errors are surfaced by the active provider/API action */ });
    }, 4000);
    return () => window.clearInterval(timer);
  }, [pageState.phase === 'joined' ? pageState.room.session.session_id : null, user?.token]);

  useEffect(() => {
    if (pageState.phase !== 'joined') return;
    exitStartedRef.current = false;
    setIsExiting(false);
    const file = pageState.room.files.find((item) => item.id === pageState.activeFileId);
    if (file?.language) setRunLanguage(file.language);
  }, [
    pageState.phase === 'joined' ? pageState.room.session.session_id : null,
    pageState.phase === 'joined' ? pageState.activeFileId : null,
  ]);

  // ---------------------------------------------------------------------------
  // Create a new collaboration room
  // ---------------------------------------------------------------------------

  const handleCreateRoom = async () => {
    if (!user) return;

    setPageState({ phase: 'loading', message: 'Creating collaboration session…' });
    try {
      const activeFile = activeFileId ? nodes[activeFileId] : null;
      const sessionFileLanguage = activeFile?.language && (FALLBACK_LANGUAGES as readonly string[]).includes(activeFile.language)
        ? activeFile.language
        : null;
      const sessionName = activeFile?.name
        ? `Session: ${activeFile.name}`
        : `Session ${new Date().toLocaleDateString()}`;

      const session = await createCollabSession(sessionName, user.token);
      await joinCollabSession(session.session_id, user.token);

      // F5: Create the active file in the session
      const file = await createCollabFile(
        session.session_id,
        activeFile?.name ?? 'main.py',
        sessionFileLanguage,
        activeFile?.content ?? '',
        user.token,
      );

      // F4: Navigate to the collaboration URL with the session ID as the room
      const sessionId = session.session_id;
      navigate(`/collaboration/${encodeURIComponent(sessionId)}`);

      setPageState({
        phase: 'joined',
        room: { session, files: [file] },
        activeFileId: file.id,
      });
    } catch (error) {
      setPageState({
        phase: 'error',
        message: `Failed to create room: ${extractErrorMessage(error)}`,
        retryable: true,
      });
    }
  };

  // ---------------------------------------------------------------------------
  // Join by entered room ID
  // ---------------------------------------------------------------------------

  const handleJoin = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const roomId = enteredRoomId.trim();
    if (!isValidRoomId(roomId)) {
      setValidationError('Enter a valid room ID (UUID format).');
      return;
    }
    if (!user) {
      setValidationError('Please sign in first.');
      return;
    }
    setValidationError(null);
    navigate(`/collaboration/${encodeURIComponent(roomId)}`);
  };

  // ---------------------------------------------------------------------------
  // Copy share link
  // ---------------------------------------------------------------------------

  const handleCopyLink = async () => {
    if (!routeRoomId) return;
    const shareUrl = `${window.location.origin}/collaboration/${encodeURIComponent(routeRoomId)}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopyMessage('Share link copied! Send it to collaborators.');
    } catch {
      setCopyMessage('Could not copy link. Share this URL manually: ' + shareUrl);
    }
  };

  // ---------------------------------------------------------------------------
  // Provider status callback
  // ---------------------------------------------------------------------------

  const handleProviderStatus = useCallback((_fileId: string, snapshot: ProviderSnapshot) => {
    setProviderSnapshot(snapshot);
  }, []);

  // ---------------------------------------------------------------------------
  // Render: joined state (real-time editor)
  // ---------------------------------------------------------------------------

  if (pageState.phase === 'joined' && user) {
    const { room, activeFileId: activeCollabFileId } = pageState;
    const activeFile = room.files.find((f) => f.id === activeCollabFileId) ?? room.files[0];

    const collabContext: CollabContext = {
      sessionId: room.session.session_id,
      token: user.token,
      displayName: user.displayName,
    };

    const statusStyles: Record<string, string> = {
      'local-only': 'border-neutral-700 text-neutral-400',
      connecting: 'border-amber-500/20 text-amber-400',
      connected: 'border-emerald-500/20 text-emerald-400',
      offline: 'border-neutral-600 text-neutral-400',
      syncing: 'border-blue-500/20 text-blue-400',
      error: 'border-red-500/20 text-red-400',
    };
    const statusLabels: Record<string, string> = {
      'local-only': 'Local',
      connecting: 'Connecting…',
      connected: 'Connected',
      offline: 'Offline',
      syncing: 'Syncing…',
      error: 'Error',
    };

    const isOwner = user.id === room.session.owner_id;

    const submitFilePath = async () => {
      const path = filePathDraft.trim();
      if (!path || path.length > 255 || path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
        setFileError('Enter a valid relative path (up to 255 characters).');
        return;
      }
      try {
        if (fileDialog === 'rename' && activeFile) {
          const updated = await renameCollabFile(room.session.session_id, activeFile.id, path, user.token);
          setPageState((prev) => prev.phase === 'joined' ? { ...prev, room: { ...prev.room, files: prev.room.files.map((f) => f.id === updated.id ? updated : f) } } : prev);
        } else {
          const detectedLanguage = detectLanguageFromFilename(path);
          const language = detectedLanguage && (FALLBACK_LANGUAGES as readonly string[]).includes(detectedLanguage) ? detectedLanguage : null;
          const starter = language ? getLanguageTemplate(language) : '';
          const newFile = await createCollabFile(room.session.session_id, path, language, starter, user.token);
          setPageState((prev) => prev.phase === 'joined' ? { ...prev, room: { ...prev.room, files: [...prev.room.files, newFile] }, activeFileId: newFile.id } : prev);
        }
        setFileDialog(null);
        setFileError(null);
      } catch (err) {
        setFileError(extractErrorMessage(err));
      }
    };

    const handleDeleteSessionFile = () => {
      if (!activeFile || !isOwner) return;
      setDeleteFileError(null);
      setFileToDelete(activeFile);
    };

    const confirmDeleteSessionFile = async () => {
      if (!fileToDelete || !isOwner || isDeletingFile) return;
      setIsDeletingFile(true);
      setDeleteFileError(null);
      try {
        await deleteCollabFile(room.session.session_id, fileToDelete.id, user.token);
        const remaining = room.files.filter((f) => f.id !== fileToDelete.id);
        if (remaining.length === 0) {
          const starter = getLanguageTemplate('python');
          const def = await createCollabFile(room.session.session_id, 'main.py', 'python', starter, user.token);
          remaining.push({ ...def, content: starter });
        }
        setPageState((prev) =>
          prev.phase === 'joined'
            ? {
                ...prev,
                room: { ...prev.room, files: remaining },
                activeFileId: remaining[0].id,
              }
            : prev,
        );
        setFileToDelete(null);
      } catch (err) {
        setDeleteFileError(extractErrorMessage(err));
      } finally {
        setIsDeletingFile(false);
      }
    };

    const openSharedFile = async (fileId: string) => {
      setFileError(null);
      try {
        const detail = await getCollabFile(room.session.session_id, fileId, user.token);
        setPageState((prev) => prev.phase === 'joined' ? {
          ...prev,
          room: { ...prev.room, files: prev.room.files.map((file) => file.id === fileId ? { ...file, content: detail.content } : file) },
          activeFileId: fileId,
        } : prev);
      } catch (error) {
        setFileError(extractErrorMessage(error));
      }
    };

    const handleCopyRoomId = async () => {
      try {
        await navigator.clipboard.writeText(room.session.session_id);
        setCopyMessage('Room ID copied.');
      } catch {
        setCopyMessage(`Copy unavailable. Room ID: ${room.session.session_id}`);
      }
    };

    const handleFormat = async () => {
      if (!activeFile || !isFormattable(runLanguage)) return;
      try {
        const source = getFileDocumentContent(activeFile.id, room.session.session_id) ?? activeFile.content ?? '';
        const formatted = await formatCode(source, runLanguage);
        setFileDocumentContent(activeFile.id, formatted, room.session.session_id);
        addTerminalLine('info', `Formatted ${activeFile.path}.`);
      } catch (error) {
        addTerminalLine('error', `Format failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    return (
      <div className="flex h-full min-h-0 gap-3 p-4">
        {showSidebar && <aside className="flex w-52 shrink-0 flex-col overflow-hidden rounded-lg border border-white/10 bg-neutral-900/50 sm:w-60">
          <div className="border-b border-white/10 p-3">
            <div className="truncate text-sm font-medium text-neutral-200">{room.session.name}</div>
            <div className="mt-2 flex items-center justify-between gap-2"><div className="text-[10px] uppercase tracking-wide text-neutral-500">Room ID</div><button type="button" onClick={() => void handleCopyRoomId()} className="shrink-0 rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-neutral-300 hover:bg-white/5">Copy ID</button></div>
            <code className="mt-1 block truncate font-mono text-[11px] text-neutral-300" title={room.session.session_id}>{room.session.session_id}</code>
            <button type="button" onClick={() => void handleCopyLink()} className="mt-2 w-full rounded-md border border-white/10 px-2 py-1.5 text-xs text-neutral-300 transition hover:bg-white/5">Copy share link</button>
            {copyMessage && <p className="mt-1 break-words text-[10px] text-neutral-400" role="status">{copyMessage}</p>}
          </div>
          <div className="border-b border-white/10 p-3">
            <div className="mb-2 flex items-center justify-between text-[10px] font-medium uppercase tracking-wide text-neutral-500"><span>Collaborators</span><span className={`rounded-full border px-1.5 py-0.5 normal-case tracking-normal ${statusStyles[providerSnapshot?.status ?? 'connecting'] ?? ''}`} title={providerSnapshot?.message}>{statusLabels[providerSnapshot?.status ?? 'connecting']}</span></div>
            {providerSnapshot?.awareness && <ParticipantPresence awareness={providerSnapshot.awareness} showNames />}
            {providerSnapshot?.status === 'error' && <p className="mt-2 text-xs text-red-400" role="alert">{providerSnapshot.message}</p>}
          </div>
          <div className="flex items-center justify-between px-3 pb-2 pt-3"><span className="text-[10px] font-medium uppercase tracking-wide text-neutral-500">Shared files</span><button type="button" onClick={() => { setFilePathDraft(''); setFileError(null); setFileDialog('create'); }} className="rounded border border-white/10 px-2 py-1 text-xs text-neutral-300 hover:bg-white/5">+ New</button></div>
          <div className="min-h-0 flex-1 overflow-auto px-2 pb-2" role="listbox" aria-label="Shared files">
            {room.files.map((file) => <button key={file.id} type="button" role="option" aria-selected={file.id === activeCollabFileId} onClick={() => void openSharedFile(file.id)} className={`mb-1 flex w-full items-center rounded-md px-2 py-2 text-left text-xs transition ${file.id === activeCollabFileId ? 'bg-emerald-500/10 text-emerald-300' : 'text-neutral-300 hover:bg-white/5'}`}><span className="truncate">{file.path}</span></button>)}
          </div>
          <div className="flex gap-1 border-t border-white/10 p-2"><button type="button" disabled={!activeFile} onClick={() => { if (activeFile) { setFilePathDraft(activeFile.path); setFileError(null); setFileDialog('rename'); } }} className="flex-1 rounded border border-white/10 px-2 py-1.5 text-xs text-neutral-300 hover:bg-white/5 disabled:opacity-40">Rename</button><button type="button" disabled={!activeFile || !isOwner} onClick={() => void handleDeleteSessionFile()} title={isOwner ? 'Delete the selected shared file' : 'Only the room owner can delete shared files'} aria-label={isOwner ? 'Delete shared file' : 'Delete shared file (owner only)'} className="rounded border border-red-500/20 px-2 py-1.5 text-xs text-red-400 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40">Delete</button></div>
        </aside>}

        <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2"><button type="button" onClick={() => setShowSidebar((visible) => !visible)} className="rounded border border-white/10 px-2 py-1.5 text-xs text-neutral-300 hover:bg-white/5" aria-label={showSidebar ? 'Hide collaboration sidebar' : 'Show collaboration sidebar'}>Files</button><span className="truncate text-sm text-neutral-300">{activeFile?.path ?? room.session.name}</span><LanguageSelector value={runLanguage} onChange={setRunLanguage} disabled={!activeFile} /></div>
            <div className="flex items-center gap-2"><button type="button" onClick={() => setLayout((current) => current === 'horizontal' ? 'vertical' : 'horizontal')} className="rounded px-2 py-1.5 text-xs text-neutral-400 hover:bg-neutral-800/40 hover:text-neutral-200" title={`Switch to ${layout === 'horizontal' ? 'vertical' : 'horizontal'} layout`}>{layout === 'horizontal' ? 'Vertical' : 'Horizontal'}</button><button type="button" onClick={() => setShowTerminal((visible) => !visible)} className="rounded px-2 py-1.5 text-xs text-neutral-400 hover:bg-neutral-800/40 hover:text-neutral-200">{showTerminal ? 'Hide terminal' : 'Show terminal'}</button><EditorToolbar onRun={() => run(getFileDocumentContent(activeCollabFileId, room.session.session_id) ?? activeFile?.content ?? '', runLanguage, useExecutionStore.getState().stdin)} onStop={cancel} onClear={() => setFileDocumentContent(activeCollabFileId, '', room.session.session_id)} onFormat={() => void handleFormat()} isRunning={isRunning} canFormat={isFormattable(runLanguage)} /></div>
          </div>
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto border-b border-white/10" role="tablist" aria-label="Open shared files">{room.files.map((file) => <button key={file.id} type="button" role="tab" aria-selected={file.id === activeCollabFileId} onClick={() => void openSharedFile(file.id)} title={file.path} className={`max-w-48 shrink-0 truncate border-b-2 px-3 py-2 text-xs ${file.id === activeCollabFileId ? 'border-emerald-400 text-neutral-100' : 'border-transparent text-neutral-500 hover:text-neutral-300'}`}>{file.path}</button>)}</div>
          <div ref={editorTerminalRef} className={`flex min-h-0 flex-1 overflow-hidden ${layout === 'horizontal' ? 'flex-col' : 'flex-row'}`}>
            <div style={showTerminal ? (layout === 'horizontal' ? { height: `${panelSize}%` } : { width: `${panelSize}%` }) : undefined} className={`flex min-h-0 min-w-0 flex-col overflow-hidden ${showTerminal ? 'shrink-0' : 'flex-1'}`}>
              {activeFile && <CodeEditor key={`collab-${activeFile.id}`} fileId={activeFile.id} language={runLanguage} initialContent={activeFile.content ?? ''} onProviderStatus={handleProviderStatus} collabContext={collabContext} />}
            </div>
            {showTerminal && <>
              <div onMouseDown={() => setIsDragging(true)} className={`shrink-0 bg-gradient-to-r from-transparent via-emerald-500/40 to-transparent transition hover:via-emerald-500/60 ${isDragging ? 'via-emerald-500/80' : ''} ${layout === 'horizontal' ? 'h-1 w-full cursor-row-resize' : 'h-full w-1 cursor-col-resize'}`} role="separator" aria-label={`Resize editor and terminal (${layout} layout)`} />
              <div style={layout === 'horizontal' ? { height: `${100 - panelSize}%` } : { width: `${100 - panelSize}%` }} className="flex min-h-0 min-w-0 flex-col overflow-hidden"><OutputPanel /></div>
            </>}
          </div>
          <div className="flex justify-end"><button type="button" disabled={isExiting} onClick={() => {
            if (exitStartedRef.current) return;
            exitStartedRef.current = true;
            setIsExiting(true);
            // Leave the collaboration view immediately. The membership request is
            // best-effort in the background so a slow API cannot trap the user here.
            try {
              window.sessionStorage.removeItem('glasshouse:last-collaboration-room');
            } catch {
              // Exiting the room must still work when storage is unavailable.
            }
            window.dispatchEvent(new Event('glasshouse:collaboration-exited'));
            navigate('/collaboration', { replace: true });
            setPageState({ phase: 'idle' });
            void leaveCollabSession(room.session.session_id, user.token)
              .catch((error) => setExitMessage(`You left this page, but room membership could not be updated: ${extractErrorMessage(error)}`));
          }} title="Leave this collaboration room and return to the Collaboration page. The shared session stays open." className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-neutral-300 transition hover:bg-white/5 disabled:cursor-wait disabled:opacity-50">{isExiting ? 'Exiting…' : 'Exit Collaboration'}</button></div>
        </section>
        {fileDialog && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="session-file-dialog-title">
            <form className="w-full max-w-md rounded-lg border border-white/10 bg-neutral-900 p-5 shadow-xl" onSubmit={(e) => { e.preventDefault(); void submitFilePath(); }}>
              <h2 id="session-file-dialog-title" className="mb-3 text-sm font-semibold text-neutral-100">{fileDialog === 'create' ? 'Create file' : 'Rename file'}</h2>
              <label className="mb-1 block text-xs text-neutral-400" htmlFor="session-file-path">Relative file path</label>
              <input id="session-file-path" autoFocus value={filePathDraft} onChange={(e) => setFilePathDraft(e.target.value)} className="w-full rounded border border-white/10 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100" placeholder="utils.py" />
              {fileError && <p className="mt-2 text-xs text-red-400" role="alert">{fileError}</p>}
              <div className="mt-4 flex justify-end gap-2"><button type="button" onClick={() => setFileDialog(null)} className="rounded border border-white/10 px-3 py-1.5 text-sm text-neutral-300">Cancel</button><button type="submit" className="rounded bg-emerald-500 px-3 py-1.5 text-sm font-medium text-neutral-950">{fileDialog === 'create' ? 'Create' : 'Save'}</button></div>
            </form>
          </div>
        )}
        {fileToDelete && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4" role="presentation">
            <section className="w-full max-w-md rounded-lg border border-white/10 bg-neutral-900 p-5 shadow-xl" role="alertdialog" aria-modal="true" aria-labelledby="delete-shared-file-title" aria-describedby="delete-shared-file-description">
              <h2 id="delete-shared-file-title" className="text-sm font-semibold text-neutral-100">Delete shared file?</h2>
              <p id="delete-shared-file-description" className="mt-2 text-sm text-neutral-400">Delete <span className="font-mono text-neutral-200">{fileToDelete.path}</span>? This action cannot be undone.</p>
              {deleteFileError && <p className="mt-3 rounded border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-400" role="alert">{deleteFileError}</p>}
              <div className="mt-5 flex justify-end gap-2">
                <button type="button" disabled={isDeletingFile} onClick={() => { setFileToDelete(null); setDeleteFileError(null); }} className="rounded-md border border-white/10 px-3 py-1.5 text-sm text-neutral-300 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50">Cancel</button>
                <button type="button" disabled={isDeletingFile} onClick={() => void confirmDeleteSessionFile()} className="rounded-md bg-red-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-red-400 disabled:cursor-wait disabled:opacity-50">{isDeletingFile ? 'Deleting…' : 'Delete'}</button>
              </div>
            </section>
          </div>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: not authenticated
  // ---------------------------------------------------------------------------

  if (!user) {
    return (
      <div className="mx-auto flex h-full w-full max-w-3xl flex-col items-center justify-center gap-6 p-6">
        <header className="text-center">
          <h1 className="text-lg font-semibold text-neutral-100">Collaboration</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Sign in to create or join a real-time collaboration session.
          </p>
        </header>
        <AuthSection onSuccess={() => {
          // If there's a roomId in the URL, auto-join after login
          if (routeRoomId && isValidRoomId(routeRoomId)) {
            setPageState({ phase: 'idle' });
          }
        }} />
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: loading / error
  // ---------------------------------------------------------------------------

  if (pageState.phase === 'loading') {
    return (
      <div className="mx-auto flex h-full w-full max-w-3xl flex-col items-center justify-center gap-4 p-6">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" role="status" aria-label="Loading" />
        <p className="text-sm text-neutral-400">{pageState.message}</p>
      </div>
    );
  }

  if (pageState.phase === 'error') {
    return (
      <div className="mx-auto flex h-full w-full max-w-3xl flex-col items-center justify-center gap-4 p-6">
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-400" role="alert">
          {pageState.message}
        </div>
        {pageState.retryable && routeRoomId && (
          <button
            type="button"
            onClick={() => {
              setPageState({ phase: 'idle' });
              if (user && routeRoomId && isValidRoomId(routeRoomId)) {
                void joinSession(routeRoomId, user.token);
              }
            }}
            className="rounded-md border border-white/10 px-4 py-2 text-sm text-neutral-300 transition hover:bg-white/5"
          >
            Retry
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setPageState({ phase: 'idle' });
            navigate('/collaboration');
          }}
          className="text-xs text-neutral-500 hover:text-neutral-300"
        >
          ← Back to collaboration home
        </button>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: idle (no room) — create or join
  // ---------------------------------------------------------------------------

  const activeFile = activeFileId ? nodes[activeFileId] : null;
  const shareUrl = routeRoomId
    ? `${window.location.origin}/collaboration/${encodeURIComponent(routeRoomId)}`
    : null;

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-5 overflow-auto p-6">
      <header>
        <h1 className="text-lg font-semibold text-neutral-100">Collaboration</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Signed in as <span className="text-neutral-300">{user.displayName}</span>.{' '}
          Create a room to collaborate in real time, or join an existing one.
        </p>
      </header>

      {exitMessage && <p className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300" role="status">{exitMessage}</p>}

      {/* F4: Create room */}
      <section className="rounded-lg border border-white/10 bg-neutral-900/60 p-4">
        <h2 className="text-sm font-medium text-neutral-200">Create a collaboration room</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Creates a new session with the active file and gives you a share link.
          Anyone with the link can join the same room.
        </p>
        <button
          type="button"
          onClick={() => void handleCreateRoom()}
          disabled={!activeFile}
          className="mt-3 rounded-md bg-emerald-500 px-4 py-1.5 text-sm font-medium text-neutral-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Create room for active file
        </button>
        {!activeFile && (
          <p className="mt-2 text-xs text-neutral-600">
            Open a file in the Editor first.
          </p>
        )}
      </section>

      {/* F4: Join room */}
      <section className="rounded-lg border border-white/10 bg-neutral-900/60 p-4">
        <h2 className="text-sm font-medium text-neutral-200">Join a room</h2>
        <form className="mt-3 flex flex-col gap-2 sm:flex-row" onSubmit={handleJoin}>
          <input
            aria-label="Room ID"
            value={enteredRoomId}
            onChange={(e) => setEnteredRoomId(e.target.value)}
            placeholder="Session ID (UUID)"
            className="min-w-0 flex-1 rounded-md border border-white/10 bg-neutral-950 px-3 py-1.5 font-mono text-sm text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-emerald-500/50"
          />
          <button
            type="submit"
            className="rounded-md border border-white/10 px-4 py-1.5 text-sm text-neutral-300 transition hover:bg-white/5 hover:text-neutral-100"
          >
            Join
          </button>
        </form>
        {validationError && (
          <p className="mt-2 text-xs text-red-400" role="alert">{validationError}</p>
        )}

        {/* F4: If URL already has a valid room ID, show share link */}
        {routeRoomId && isValidRoomId(routeRoomId) && shareUrl && (
          <div className="mt-4 rounded-md border border-white/10 bg-neutral-950/60 p-3">
            <p className="mb-2 text-xs text-neutral-500">Collaboration room link:</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                readOnly
                aria-label="Share link"
                value={shareUrl}
                className="min-w-0 flex-1 rounded-md border border-white/10 bg-neutral-950 px-3 py-1.5 font-mono text-xs text-neutral-300"
              />
              <button
                type="button"
                onClick={() => void handleCopyLink()}
                className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-neutral-300 transition hover:bg-white/5"
              >
                Copy
              </button>
            </div>
            {copyMessage && (
              <p className="mt-1 text-xs text-neutral-400" role="status">{copyMessage}</p>
            )}
            <button
              type="button"
              onClick={() => {
                if (user) void joinSession(routeRoomId, user.token);
              }}
              className="mt-2 rounded-md bg-emerald-500 px-4 py-1.5 text-sm font-medium text-neutral-950 transition hover:bg-emerald-400"
            >
              Join this room
            </button>
          </div>
        )}
      </section>

      {/* Sign out */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => useAuthStore.getState().logout()}
          className="text-xs text-neutral-600 hover:text-neutral-400"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
