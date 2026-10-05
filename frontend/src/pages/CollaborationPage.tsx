import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  createRoomPreview,
  isValidRoomId,
  type CollaborationRoomPreview,
} from '../collaboration/session';
import { useWorkspaceStore } from '../state/workspaceStore';

export function CollaborationPage() {
  const { roomId: routeRoomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const activeFileId = useWorkspaceStore((state) => state.activeFileId);
  const nodes = useWorkspaceStore((state) => state.nodes);
  const [enteredRoomId, setEnteredRoomId] = useState('');
  const [roomPreview, setRoomPreview] = useState<CollaborationRoomPreview | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);

  const currentRoomId = routeRoomId ?? '';
  const currentRoomIsValid = isValidRoomId(currentRoomId);
  const activeFile =
    activeFileId && nodes[activeFileId]?.type === 'file' ? nodes[activeFileId] : null;

  const handleJoin = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const roomId = enteredRoomId.trim();
    if (!isValidRoomId(roomId)) {
      setValidationError('Enter a valid room ID (workspace file UUID).');
      return;
    }

    setValidationError(null);
    setRoomPreview(null);
    setCopyMessage(null);
    navigate(`/collaboration/${encodeURIComponent(roomId)}`);
  };

  const handleCreatePreview = () => {
    if (!activeFileId || !activeFile || typeof window === 'undefined') return;
    try {
      setRoomPreview(createRoomPreview(activeFileId, window.location.origin));
      setValidationError(null);
      setCopyMessage(null);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleCopyLink = async () => {
    if (!roomPreview) return;
    try {
      await navigator.clipboard.writeText(roomPreview.shareUrl);
      setCopyMessage('Preview link copied. It will not connect collaborators yet.');
    } catch (error) {
      setCopyMessage(
        `Could not copy preview link: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-5 overflow-auto p-6">
      <header>
        <h1 className="text-lg font-semibold text-neutral-100">Collaboration</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Create or open a room link preview. No room is created or joined until a collaboration
          backend is available.
        </p>
      </header>

      <section className="rounded-lg border border-white/10 bg-neutral-900/60 p-4">
        <h2 className="text-sm font-medium text-neutral-200">Create a share-link preview</h2>
        <p className="mt-1 text-xs text-neutral-500">
          The link uses the active file ID as a room identifier. It does not share file contents,
          create a server session, or connect another user.
        </p>
        <button
          type="button"
          onClick={handleCreatePreview}
          disabled={!activeFile}
          className="mt-3 rounded-md bg-emerald-500 px-4 py-1.5 text-sm font-medium text-neutral-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Generate preview link for active file
        </button>

        {roomPreview && (
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              aria-label="Preview share link"
              className="min-w-0 flex-1 rounded-md border border-white/10 bg-neutral-950 px-3 py-1.5 font-mono text-xs text-neutral-300"
              value={roomPreview.shareUrl}
              readOnly
            />
            <button
              type="button"
              onClick={() => void handleCopyLink()}
              className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-neutral-300 transition hover:bg-white/5 hover:text-neutral-100"
            >
              Copy preview link
            </button>
          </div>
        )}
        {copyMessage && (
          <p className="mt-2 text-xs text-neutral-400" role="status">
            {copyMessage}
          </p>
        )}
      </section>

      <section className="rounded-lg border border-white/10 bg-neutral-900/60 p-4">
        <h2 className="text-sm font-medium text-neutral-200">Open a room link</h2>
        <form className="mt-3 flex flex-col gap-2 sm:flex-row" onSubmit={handleJoin}>
          <input
            aria-label="Room ID"
            value={enteredRoomId}
            onChange={(event) => setEnteredRoomId(event.target.value)}
            placeholder="Room ID (workspace file UUID)"
            className="min-w-0 flex-1 rounded-md border border-white/10 bg-neutral-950 px-3 py-1.5 font-mono text-sm text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-emerald-500/50"
          />
          <button
            type="submit"
            className="rounded-md border border-white/10 px-4 py-1.5 text-sm text-neutral-300 transition hover:bg-white/5 hover:text-neutral-100"
          >
            Open link
          </button>
        </form>
        {validationError && (
          <p className="mt-2 text-xs text-red-400" role="alert">
            {validationError}
          </p>
        )}

        {routeRoomId && (
          <div className="mt-3 rounded-md border px-3 py-2 text-xs">
            {currentRoomIsValid ? (
              <div className="border-amber-500/20 text-amber-300" role="status">
                Room ID is valid, but no collaboration service is available. You have not joined a
                room.
              </div>
            ) : (
              <p className="text-red-400" role="alert">
                Invalid room ID. Expected a workspace file UUID.
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
