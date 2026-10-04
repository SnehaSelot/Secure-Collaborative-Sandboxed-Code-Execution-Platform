import { useState, useRef, useEffect, useCallback } from 'react';
import { FileExplorer } from '../features/explorer/FileExplorer';
import { CodeEditor } from '../features/editor/CodeEditor';
import { LanguageSelector } from '../features/editor/LanguageSelector';
import { EditorToolbar } from '../features/editor/EditorToolbar';
import { OutputPanel } from '../features/execution/OutputPanel';
import { ParticipantPresence } from '../features/editor/ParticipantPresence';
import { useWorkspaceStore } from '../state/workspaceStore';
import { useExecutionStore } from '../state/executionStore';
import { getFileDocumentContent } from '../state/fileDocumentRegistry';
import { formatCode, isFormattable } from '../utils/formatCode';
import { useStreamExecution } from '../hooks/useStreamExecution';
import type { ProviderSnapshot } from '../collaboration/provider';

interface FileProviderStatus {
  fileId: string;
  snapshot: ProviderSnapshot;
}

const PROVIDER_STATUS_STYLES: Record<ProviderSnapshot['status'], string> = {
  'local-only': 'border-neutral-700 bg-neutral-800/70 text-neutral-400',
  connecting: 'border-amber-500/20 bg-amber-500/10 text-amber-400',
  connected: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400',
  offline: 'border-neutral-600 bg-neutral-800/70 text-neutral-400',
  syncing: 'border-blue-500/20 bg-blue-500/10 text-blue-400',
  error: 'border-red-500/20 bg-red-500/10 text-red-400',
};

const PROVIDER_STATUS_LABELS: Record<ProviderSnapshot['status'], string> = {
  'local-only': 'Local only',
  connecting: 'Connecting',
  connected: 'Connected',
  offline: 'Offline',
  syncing: 'Syncing',
  error: 'Collaboration error',
};

/**
 * Phase 2: the editor is file-centric rather than language-centric.
 *
 * Each file owns its own content and language through workspaceStore.
 *
 * The LanguageSelector edits the active file's language, similar to
 * a language-mode picker in VS Code.
 */
export function EditorPage() {
  const nodes = useWorkspaceStore((s) => s.nodes);
  const activeFileId = useWorkspaceStore((s) => s.activeFileId);
  const setActiveFileContent = useWorkspaceStore((s) => s.setActiveFileContent);
  const setActiveFileLanguage = useWorkspaceStore((s) => s.setActiveFileLanguage);
  const clearActiveFileContent = useWorkspaceStore((s) => s.clearActiveFileContent);

  const activeFile = activeFileId ? nodes[activeFileId] : undefined;
  const [providerStatus, setProviderStatus] = useState<FileProviderStatus | null>(null);
  const handleProviderStatus = useCallback((fileId: string, snapshot: ProviderSnapshot) => {
    setProviderStatus({ fileId, snapshot });
  }, []);
  const activeProviderSnapshot =
    providerStatus && providerStatus.fileId === activeFile?.id ? providerStatus.snapshot : null;

  const { run, cancel, isRunning } = useStreamExecution();
  // Used to show formatting success/errors in the integrated Terminal.
  const addTerminalLine = useExecutionStore((s) => s.addTerminalLine);
  // Resizable editor/terminal with layout toggle.
  const [layout, setLayout] = useState<'horizontal' | 'vertical'>('horizontal');
  const [panelSize, setPanelSize] = useState(60);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging || !containerRef.current) return;

      const container = containerRef.current;
      const rect = container.getBoundingClientRect();

      let newSize: number;

      if (layout === 'horizontal') {
        // Resize vertically: update height.
        newSize = ((e.clientY - rect.top) / rect.height) * 100;
      } else {
        // Resize horizontally: update width.
        newSize = ((e.clientX - rect.left) / rect.width) * 100;
      }

      // Minimum 20% for each panel.
      if (newSize >= 20 && newSize <= 80) {
        setPanelSize(newSize);
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);

      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, layout]);

  const handleRun = () => {
    const { activeFileId: currentFileId, nodes: currentNodes } = useWorkspaceStore.getState();
    if (!currentFileId) return;

    const currentFile = currentNodes[currentFileId];
    if (!currentFile || currentFile.type !== 'file') return;

    const code = getFileDocumentContent(currentFileId) ?? currentFile.content ?? '';
    const currentStdin = useExecutionStore.getState().stdin;
    run(code, currentFile.language ?? 'plaintext', currentStdin);
  };

  /**
   * Phase 2: client-side formatting.
   *
   * Currently JavaScript is formatted locally using Prettier.
   * Other languages remain disabled until backend formatting support
   * is implemented.
   */
  const handleFormat = async () => {
    if (!activeFile) return;

    try {
      const formatted = await formatCode(activeFile.content ?? '', activeFile.language ?? '');

      setActiveFileContent(formatted);

      addTerminalLine('info', `Formatted ${activeFile.name}.`);
    } catch (err) {
      addTerminalLine('error', `Format failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="flex h-full gap-4 p-4">
      <FileExplorer />

      {activeFile ? (
        <section className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-sm text-neutral-400">{activeFile.name}</span>
              {activeProviderSnapshot && (
                <>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${PROVIDER_STATUS_STYLES[activeProviderSnapshot.status]}`}
                    role="status"
                    aria-live="polite"
                    title={activeProviderSnapshot.message}
                  >
                    {PROVIDER_STATUS_LABELS[activeProviderSnapshot.status]}
                  </span>
                  <ParticipantPresence awareness={activeProviderSnapshot.awareness} />
                </>
              )}

              <LanguageSelector
                value={activeFile.language ?? 'plaintext'}
                onChange={setActiveFileLanguage}
              />
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setLayout(layout === 'horizontal' ? 'vertical' : 'horizontal')}
                className="flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium text-neutral-400 transition hover:bg-neutral-800/40 hover:text-neutral-200"
                title={`Switch to ${layout === 'horizontal' ? 'vertical' : 'horizontal'} layout`}
              >
                {layout === 'horizontal' ? (
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M8 19h8M8 5h8M3 9h2v6H3M19 9h2v6h-2" />
                  </svg>
                ) : (
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M19 8v8M5 8v8M9 3v2h6V3M9 19v2h6v-2" />
                  </svg>
                )}

                {layout === 'horizontal' ? 'Vertical' : 'Horizontal'}
              </button>

              <EditorToolbar
                isRunning={isRunning}
                onRun={handleRun}
                onClear={clearActiveFileContent}
                onStop={cancel}
                onFormat={handleFormat}
                canFormat={isFormattable(activeFile.language ?? '')}
              />
            </div>
          </div>

          {/* Resizable editor and terminal area */}
          <div
            className={`flex min-h-0 flex-1 ${layout === 'horizontal' ? 'flex-col' : 'flex-row'}`}
            ref={containerRef}
          >
            {/* Editor */}
            <div
              style={
                layout === 'horizontal' ? { height: `${panelSize}%` } : { width: `${panelSize}%` }
              }
              className="flex min-h-0 min-w-0 flex-col overflow-hidden"
            >
              <CodeEditor
                key={activeFile.id}
                fileId={activeFile.id}
                language={activeFile.language ?? 'plaintext'}
                onProviderStatus={handleProviderStatus}
              />
            </div>

            {/* Resizable divider */}
            <div
              onMouseDown={() => setIsDragging(true)}
              className={`bg-gradient-to-r from-transparent via-emerald-500/40 to-transparent transition hover:via-emerald-500/60 ${
                isDragging ? 'via-emerald-500/80' : ''
              } ${
                layout === 'horizontal'
                  ? 'h-1 w-full cursor-row-resize'
                  : 'h-full w-1 cursor-col-resize'
              }`}
              role="separator"
              aria-label={`Resize editor and terminal (${layout} layout)`}
            />

            {/* Integrated Terminal */}
            <div
              style={
                layout === 'horizontal'
                  ? { height: `${100 - panelSize}%` }
                  : { width: `${100 - panelSize}%` }
              }
              className="flex min-h-0 min-w-0 flex-col overflow-hidden"
            >
              <OutputPanel />
            </div>
          </div>
        </section>
      ) : (
        <section className="flex flex-1 items-center justify-center rounded-lg border border-white/10 bg-neutral-900/40">
          <p className="text-sm text-neutral-500">
            No file open — select a file in the Explorer, or create a new one.
          </p>
        </section>
      )}
    </div>
  );
}