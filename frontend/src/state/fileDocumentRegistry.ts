import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { getFileRoomName } from '../config/collaboration';
import { createProvider, type CollaborationProvider } from '../collaboration/provider';
import { useWorkspaceStore } from './workspaceStore';

interface FileDocument {
  fileId: string;
  doc: Y.Doc;
  text: Y.Text;
  persistence: IndexeddbPersistence | null;
  provider: CollaborationProvider;
  ready: Promise<Error | null>;
  initialized: boolean;
  references: number;
  cleanupVersion: number;
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

const documents = new Map<string, FileDocument>();

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

useWorkspaceStore.subscribe((state) => {
  for (const entry of documents.values()) {
    if (entry.references === 0 || !entry.initialized) continue;

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

  const file = useWorkspaceStore.getState().nodes[entry.fileId];
  if (file?.type === 'file') {
    if (hasDocumentHistory) {
      useWorkspaceStore.getState().setFileContent(entry.fileId, entry.text.toString());
    } else {
      replaceText(entry.text, file.content ?? '');
    }
  }

  return persistenceError;
}

function createDocument(fileId: string): FileDocument {
  const doc = new Y.Doc();
  const text = doc.getText('source');
  const provider = createProvider({ roomName: getFileRoomName(fileId), doc });
  let persistence: IndexeddbPersistence | null = null;
  let creationError: Error | null = null;

  if (typeof indexedDB === 'undefined') {
    creationError = new Error('IndexedDB is not available in this browser.');
  } else {
    try {
      persistence = new IndexeddbPersistence(`glasshouse-yjs-file:${encodeURIComponent(fileId)}`, doc);
    } catch (error) {
      creationError = asError(error);
    }
  }

  const entry: FileDocument = {
    fileId,
    doc,
    text,
    provider,
    persistence,
    ready: Promise.resolve(null),
    initialized: false,
    references: 0,
    cleanupVersion: 0,
    onTextChange: () => {
      if (!entry.initialized) return;

      const content = text.toString();
      const file = useWorkspaceStore.getState().nodes[fileId];
      if (file?.type === 'file' && file.content !== content) {
        useWorkspaceStore.getState().setFileContent(fileId, content);
      }
    },
  };

  text.observe(entry.onTextChange);
  entry.ready = initializeDocument(entry, creationError);
  return entry;
}

export function acquireFileDocument(fileId: string): FileDocumentLease {
  let entry = documents.get(fileId);
  if (!entry) {
    entry = createDocument(fileId);
    documents.set(fileId, entry);
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
      entry.references -= 1;
      if (entry.references !== 0) return;

      const cleanupVersion = ++entry.cleanupVersion;
      void entry.ready.then(() => {
        queueMicrotask(() => {
          const current = documents.get(fileId);
          if (!current || current.references !== 0 || current.cleanupVersion !== cleanupVersion) {
            return;
          }

          current.text.unobserve(current.onTextChange);
          current.provider.destroy();
          current.doc.destroy();
          documents.delete(fileId);
        });
      });
    },
  };
}

export function getFileDocumentContent(fileId: string): string | null {
  const entry = documents.get(fileId);
  if (!entry?.initialized) return null;
  return entry.text.toString();
}
