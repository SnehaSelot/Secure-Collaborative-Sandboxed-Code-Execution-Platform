/**
 * state/fileDocumentRegistry.ts — Registry of Yjs documents per file.
 *
 * Each file has exactly one Y.Doc, shared by all editor instances that open it.
 * In solo mode: local IndexedDB persistence + local-only (StaticProvider).
 * In collab mode: IndexedDB persistence + real WebSocket provider connecting to
 *   ws://backend/ws/collab/{sessionId}:{fileId} with JWT auth.
 *
 * F5: Documents in collab mode use the canonical backend file ID and session ID
 * to form the room name, preventing different users from creating separate docs.
 */

import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { getFileRoomName, getSessionFileRoomName } from '../config/collaboration';
import { createProvider, type CollaborationProvider } from '../collaboration/provider';
import { colorForName } from '../collaboration/presence';
import { useWorkspaceStore } from './workspaceStore';
import { useAuthStore } from './authStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CollabContext {
  /** Backend session UUID */
  sessionId: string;
  /** JWT token for WebSocket auth */
  token: string;
  /** User display name for awareness */
  displayName?: string;
}

interface FileDocument {
  fileId: string;
  roomKey: string; // unique key: fileId (solo) or "{sessionId}:{fileId}" (collab)
  doc: Y.Doc;
  text: Y.Text;
  persistence: IndexeddbPersistence | null;
  provider: CollaborationProvider;
  ready: Promise<Error | null>;
  initialized: boolean;
  references: number;
  cleanupVersion: number;
  isCollab: boolean;
  onTextChange: () => void;
}

export interface FileDocumentLease {
  fileId: string;
  doc: Y.Doc;
  text: Y.Text;
  provider: CollaborationProvider;
  ready: Promise<Error | null>;
  release: () => void;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

// Key: roomKey (solo = fileId, collab = "{sessionId}:{fileId}")
const documents = new Map<string, FileDocument>();

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function replaceText(text: Y.Text, value: string): void {
  const current = text.toString();
  if (current === value) return;

  const doc = text.doc;
  if (!doc) return;

  doc.transact(() => {
    if (text.length > 0) {
      text.delete(0, text.length);
    }
    if (value.length > 0) {
      text.insert(0, value);
    }
  });
}

function soloRoomKey(fileId: string): string {
  const accountId = useAuthStore.getState().user?.id ?? 'guest';
  return `private:${encodeURIComponent(accountId)}:${fileId}`;
}

useWorkspaceStore.subscribe((state) => {
  for (const entry of documents.values()) {
    if (entry.references === 0 || !entry.initialized || entry.isCollab) continue;
    if (entry.roomKey !== soloRoomKey(entry.fileId)) continue;

    const node = state.nodes[entry.fileId];
    if (node?.type === 'file') {
      replaceText(entry.text, node.content ?? '');
    }
  }
});

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function initializeDocument(
  entry: FileDocument,
  creationError: Error | null,
  isCollab = false,
): Promise<Error | null> {
  let persistenceError = creationError;

  if (entry.persistence && !persistenceError) {
    try {
      await entry.persistence._db;
      await entry.persistence.whenSynced;
    } catch (error) {
      persistenceError = asError(error);
    }
  }

  const hasDocumentHistory = !persistenceError && Y.encodeStateVector(entry.doc).length > 1;
  entry.initialized = true;

  if (!isCollab) {
    if (entry.roomKey !== soloRoomKey(entry.fileId)) return persistenceError;
    const file = useWorkspaceStore.getState().nodes[entry.fileId];
    if (file?.type === 'file') {
      if (hasDocumentHistory) {
        useWorkspaceStore.getState().setFileContent(entry.fileId, entry.text.toString());
      } else {
        replaceText(entry.text, file.content ?? '');
      }
    }
  }

  return persistenceError;
}

// ---------------------------------------------------------------------------
// Document creation
// ---------------------------------------------------------------------------

/**
 * Create a file document.
 * In solo mode (no collabContext): local-only provider, IndexedDB keyed by fileId.
 * In collab mode: real WS provider with "{sessionId}:{fileId}" room name.
 *
 * F5: The roomKey ensures all collaborators share the same Yjs document
 * even if they have different local file IDs — the canonical backend file ID
 * is used as part of the room name.
 */
function createDocument(fileId: string, collabContext?: CollabContext): FileDocument {
  const isCollab = !!collabContext;
  const doc = new Y.Doc();
  // F5/F6: Backend pycrdt doc in ws_collab.py uses "content" key. Solo uses "source".
  const text = isCollab ? doc.getText('content') : doc.getText('source');

  // F5: Room name is "{sessionId}:{fileId}" in collab mode, just fileId in solo
  const roomName = collabContext
    ? getSessionFileRoomName(collabContext.sessionId, fileId)
    : getFileRoomName(fileId);

  // F2: Create provider with room name and optional token
  const provider = createProvider({
    roomName,
    doc,
    token: collabContext?.token,
    // Solo editor documents are local. The backend only accepts
    // {sessionId}:{fileId} rooms and requires a session JWT.
    websocketBaseUrl: collabContext ? undefined : null,
    // websocketBaseUrl: undefined means use env default (F1)
  });

  // F3: Set user awareness once provider has awareness
  if (collabContext?.displayName) {
    const snapshot = provider.getSnapshot();
    if (snapshot.awareness) {
      const { awareness } = snapshot;
      const color = colorForName(collabContext.displayName);
      awareness.setLocalStateField('user', {
        name: collabContext.displayName,
        color,
      });
    }
    // Subscribe to pick up awareness when provider connects (for WS provider)
    const unsubscribeAwareness = provider.subscribe((snap) => {
      if (snap.awareness) {
        const { awareness } = snap;
        const existing = awareness.getStates().get(awareness.clientID);
        if (!existing?.user && collabContext.displayName) {
          const color = colorForName(collabContext.displayName);
          awareness.setLocalStateField('user', {
            name: collabContext.displayName,
            color,
          });
        }
        // Only need to set once
        unsubscribeAwareness();
      }
    });
  }

  // IndexedDB persistence — keyed by roomKey to avoid sharing IDB between solo and collab
  const roomKey = collabContext
    ? `${collabContext.sessionId}:${fileId}`
    : soloRoomKey(fileId);

  let persistence: IndexeddbPersistence | null = null;
  let creationError: Error | null = null;

  if (typeof indexedDB === 'undefined') {
    creationError = new Error('IndexedDB is not available in this browser.');
  } else {
    try {
      persistence = new IndexeddbPersistence(
        `glasshouse-yjs-file:${encodeURIComponent(roomKey)}`,
        doc,
      );
    } catch (error) {
      creationError = asError(error);
    }
  }

  const entry: FileDocument = {
    fileId,
    roomKey,
    doc,
    text,
    provider,
    persistence,
    ready: Promise.resolve(null),
    initialized: false,
    references: 0,
    cleanupVersion: 0,
    isCollab,
    onTextChange: () => {
      if (!entry.initialized || isCollab || entry.roomKey !== soloRoomKey(fileId)) return;

      const content = text.toString();
      const file = useWorkspaceStore.getState().nodes[fileId];
      if (file?.type === 'file' && file.content !== content) {
        useWorkspaceStore.getState().setFileContent(fileId, content);
      }
    },
  };

  text.observe(entry.onTextChange);
  entry.ready = initializeDocument(entry, creationError, isCollab);
  return entry;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Acquire a lease on a file's Yjs document.
 *
 * In solo mode: call with just fileId.
 * In collab mode (F5): call with fileId + collabContext. The registry keyed by
 *   "{sessionId}:{fileId}" ensures all collaborators share the same doc.
 *
 * Leases are reference-counted. Call release() when done.
 */
export function acquireFileDocument(
  fileId: string,
  collabContext?: CollabContext,
): FileDocumentLease {
  const roomKey = collabContext
    ? `${collabContext.sessionId}:${fileId}`
    : soloRoomKey(fileId);

  let entry = documents.get(roomKey);
  if (!entry) {
    entry = createDocument(fileId, collabContext);
    documents.set(roomKey, entry);
  }

  entry.cleanupVersion += 1;
  entry.references += 1;
  let released = false;

  return {
    fileId,
    doc: entry.doc,
    text: entry.text,
    provider: entry.provider,
    ready: entry.ready,
    release: () => {
      if (released) return;
      released = true;
      // entry is guaranteed to be defined here (captured from outer scope)
      const e = entry!;
      e.references -= 1;
      if (e.references !== 0) return;

      const cleanupVersion = ++e.cleanupVersion;
      void e.ready.then(() => {
        queueMicrotask(() => {
          const current = documents.get(roomKey);
          if (!current || current.references !== 0 || current.cleanupVersion !== cleanupVersion) {
            return;
          }

          // F3: Clean up awareness on final release
          const aw = current.provider.getSnapshot().awareness;
          if (aw) {
            try {
              aw.setLocalState(null);
            } catch {
              // may throw if already destroyed
            }
          }

          current.text.unobserve(current.onTextChange);
          current.provider.destroy();
          current.doc.destroy();
          documents.delete(roomKey);
        });
      });
    },
  };
}

/**
 * Get the current text content of a file document, or null if not loaded.
 * Works for both solo and collab documents.
 */
export function getFileDocumentContent(fileId: string, sessionId?: string): string | null {
  const roomKey = sessionId ? `${sessionId}:${fileId}` : soloRoomKey(fileId);
  const entry = documents.get(roomKey);
  if (!entry?.initialized) return null;
  return entry.text.toString();
}

/** Update a solo or collaborative Yjs document by its canonical identity. */
export function setFileDocumentContent(fileId: string, content: string, sessionId?: string): boolean {
  const roomKey = sessionId ? `${sessionId}:${fileId}` : soloRoomKey(fileId);
  const entry = documents.get(roomKey);
  if (!entry) return false;
  const current = entry.text.toString();
  if (current === content) return true;
  entry.doc.transact(() => {
    if (entry.text.length) entry.text.delete(0, entry.text.length);
    if (content) entry.text.insert(0, content);
  });
  return true;
}


// Detach solo docs in memory on logout, while preserving each account's
// IndexedDB records and all shared collaboration documents.
if (typeof window !== 'undefined') {
  window.addEventListener('glasshouse:account-logged-out', () => {
    for (const [key, entry] of documents) {
      if (entry.isCollab) continue;
      entry.text.unobserve(entry.onTextChange);
      entry.provider.destroy();
      entry.doc.destroy();
      documents.delete(key);
    }
  });
}
