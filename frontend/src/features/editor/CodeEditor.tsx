/**
 * features/editor/CodeEditor.tsx — Monaco editor with Yjs document binding.
 *
 * F6: Connects Yjs documents and awareness to Monaco using MonacoBinding,
 * displaying collaborators' cursors and selections with their assigned colors.
 * In collab mode (collabContext provided), the provider uses the session-scoped
 * room name and JWT token to connect to the real WS backend.
 *
 * Bindings are disposed correctly when switching files or rooms.
 */

import Editor from '@monaco-editor/react';
import { useEffect, useRef, useState } from 'react';
import { MonacoBinding } from 'y-monaco';
import type * as monaco from 'monaco-editor';
import { acquireFileDocument, type CollabContext, type FileDocumentLease } from '../../state/fileDocumentRegistry';
import { usePreferencesStore } from '../../state/preferencesStore';
import { useToastStore } from '../../state/toastStore';
import type { ProviderSnapshot } from '../../collaboration/provider';
import { getEditorDisplayOptions, getResolvedTheme } from './editorOptions';

interface CodeEditorProps {
  fileId: string;
  language: string;
  onProviderStatus: (fileId: string, snapshot: ProviderSnapshot) => void;
  /** F5: Optional collab context for real-time collaboration */
  collabContext?: CollabContext;
  /** Plain text from the session file detail API, used to seed a new Yjs doc. */
  initialContent?: string;
}

/**
 * Local (or collab) Yjs document binding for one workspace file.
 *
 * When collabContext is provided, uses the real WebSocket provider connecting
 * to ws://backend/ws/collab/{sessionId}:{fileId}.
 *
 * When no collabContext: local-only IndexedDB persistence (solo editing).
 */
export function CodeEditor({
  fileId,
  language,
  onProviderStatus,
  collabContext,
  initialContent,
}: CodeEditorProps) {
  const themePreference = usePreferencesStore((state) => state.theme);
  const fontSize = usePreferencesStore((state) => state.fontSize);
  const fontFamily = usePreferencesStore((state) => state.fontFamily);
  const wordWrap = usePreferencesStore((state) => state.wordWrap);
  const tabSize = usePreferencesStore((state) => state.tabSize);
  const minimap = usePreferencesStore((state) => state.minimap);
  const lineNumbers = usePreferencesStore((state) => state.lineNumbers);
  const showCollaboratorCursors = usePreferencesStore(
    (state) => state.showCollaboratorCursors,
  );
  const [editorTheme, setEditorTheme] = useState<'light' | 'vs-dark'>('vs-dark');
  const [lease, setLease] = useState<FileDocumentLease | null>(null);

  // F6: Track the MonacoBinding instance to dispose it on file/room changes
  const bindingRef = useRef<MonacoBinding | null>(null);

  useEffect(() => {
    let active = true;
    const nextLease = acquireFileDocument(fileId, collabContext);
    onProviderStatus(fileId, nextLease.provider.getSnapshot());
    let seeded = false;
    const seedEmptyRemoteDocument = (snapshot: ProviderSnapshot) => {
      if (seeded || initialContent === undefined || snapshot.syncState !== 'synced') return;
      seeded = true;
      if (nextLease.text.length === 0 && initialContent.length > 0) {
        nextLease.doc.transact(() => nextLease.text.insert(0, initialContent));
      }
    };
    const unsubscribe = nextLease.provider.subscribe((snapshot) => {
      onProviderStatus(fileId, snapshot);
      seedEmptyRemoteDocument(snapshot);
    });
    seedEmptyRemoteDocument(nextLease.provider.getSnapshot());

    void nextLease.ready.then((persistenceError) => {
      if (!active) return;

      if (persistenceError) {
        useToastStore.getState().addToast(
          'error',
          `Local editor persistence is unavailable: ${persistenceError.message}`,
        );
      }

      setLease(nextLease);
    });

    return () => {
      active = false;
      unsubscribe();
      // F6: Dispose the Monaco binding before releasing the document
      if (bindingRef.current) {
        bindingRef.current.destroy();
        bindingRef.current = null;
      }
      nextLease.release();
    };
  // collabContext identity: spread key fields to detect actual changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, onProviderStatus, collabContext?.sessionId, collabContext?.token, initialContent]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const applyTheme = () => {
      setEditorTheme(
        getResolvedTheme(themePreference, media.matches) === 'light' ? 'light' : 'vs-dark',
      );
    };

    applyTheme();
    media.addEventListener('change', applyTheme);
    return () => media.removeEventListener('change', applyTheme);
  }, [themePreference]);

  const activeLease = lease?.fileId === fileId ? lease : null;

  return (
    <div className="h-full w-full overflow-hidden rounded-lg border border-white/10">
      {activeLease ? (
        <Editor
          key={`${fileId}-${collabContext?.sessionId ?? 'solo'}`}
          height="100%"
          language={language}
          value={activeLease.text.toString()}
          theme={editorTheme}
          onMount={(instance) => {
            const model = instance.getModel();
            if (model) {
              // F6: Dispose previous binding if switching files/rooms
              if (bindingRef.current) {
                bindingRef.current.destroy();
                bindingRef.current = null;
              }

              // F6: Connect Yjs text + awareness to Monaco
              const awareness = showCollaboratorCursors
                ? activeLease.provider.getSnapshot().awareness
                : null;

              const binding = new MonacoBinding(
                activeLease.text,
                model,
                new Set([instance as monaco.editor.IStandaloneCodeEditor]),
                awareness ?? undefined,
              );
              bindingRef.current = binding;
            }

            // Expose a goToLine helper to the Risk Analysis page via a
            // CustomEvent. The Risk Analysis page listens for "monaco-ready"
            // and stores the callback for finding navigation clicks.
            window.dispatchEvent(
              new CustomEvent('monaco-ready', {
                detail: {
                  fileId,
                  goToLine: (line: number) => {
                    instance.revealLineInCenter(line);
                    instance.setPosition({ lineNumber: line, column: 1 });
                    instance.focus();
                  },
                },
              }),
            );
          }}
          options={{
            ...getEditorDisplayOptions({
              fontSize,
              fontFamily,
              wordWrap,
              tabSize,
              minimap,
              lineNumbers,
            }),
            automaticLayout: true,
            scrollBeyondLastLine: false,
            padding: { top: 12 },
            // Explicit, not just relying on the default: without these,
            // a stale Monaco model from a previous mount can occasionally
            // come back read-only after a fast file/language switch.
            readOnly: false,
            domReadOnly: false,
          }}
        />
      ) : (
        <div
          className="flex h-full items-center justify-center bg-neutral-900/40 text-sm text-neutral-500"
          role="status"
        >
          Restoring local document…
        </div>
      )}
    </div>
  );
}
