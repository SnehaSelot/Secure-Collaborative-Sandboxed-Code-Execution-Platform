import Editor from '@monaco-editor/react';
import { useEffect, useState } from 'react';
import { MonacoBinding } from 'y-monaco';
import { acquireFileDocument, type FileDocumentLease } from '../../state/fileDocumentRegistry';
import { usePreferencesStore } from '../../state/preferencesStore';
import { useToastStore } from '../../state/toastStore';
import type { ProviderSnapshot } from '../../collaboration/provider';

interface CodeEditorProps {
  fileId: string;
  language: string;
  onProviderStatus: (fileId: string, snapshot: ProviderSnapshot) => void;
}

/**
 * Local Yjs document binding for one workspace file. IndexedDB persistence is
 * loaded before the editor mounts; no network provider is involved.
 */
export function CodeEditor({ fileId, language, onProviderStatus }: CodeEditorProps) {
  const themePreference = usePreferencesStore((state) => state.theme);
  const fontSize = usePreferencesStore((state) => state.fontSize);
  const wordWrap = usePreferencesStore((state) => state.wordWrap);
  const tabSize = usePreferencesStore((state) => state.tabSize);
  const [editorTheme, setEditorTheme] = useState<'light' | 'vs-dark'>('vs-dark');
  const [lease, setLease] = useState<FileDocumentLease | null>(null);

  useEffect(() => {
    let active = true;
    const nextLease = acquireFileDocument(fileId);
    onProviderStatus(fileId, nextLease.provider.getSnapshot());
    const unsubscribe = nextLease.provider.subscribe((snapshot) => {
      onProviderStatus(fileId, snapshot);
    });

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
      nextLease.release();
    };
  }, [fileId, onProviderStatus]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const applyTheme = () => {
      setEditorTheme(
        themePreference === 'light' || (themePreference === 'system' && media.matches)
          ? 'light'
          : 'vs-dark',
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
          key={fileId}
          height="100%"
          language={language}
          value={activeLease.text.toString()}
          theme={editorTheme}
          onMount={(instance) => {
            const model = instance.getModel();
            if (model) {
              new MonacoBinding(
                activeLease.text,
                model,
                new Set([instance]),
                activeLease.provider.getSnapshot().awareness ?? undefined,
              );
            }
          }}
          options={{
            minimap: { enabled: false },
            fontSize,
            wordWrap,
            tabSize,
            insertSpaces: true,
            lineNumbers: 'on',
            automaticLayout: true,
            scrollBeyondLastLine: false,
            padding: { top: 12 },
            fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, monospace",
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