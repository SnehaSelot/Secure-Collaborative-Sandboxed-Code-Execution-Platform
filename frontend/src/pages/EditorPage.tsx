import { useState, useRef, useEffect } from 'react';
import { FileExplorer } from '../features/explorer/FileExplorer';
import { CodeEditor } from '../features/editor/CodeEditor';
import { LanguageSelector } from '../features/editor/LanguageSelector';
import { EditorToolbar } from '../features/editor/EditorToolbar';
import { OutputPanel } from '../features/execution/OutputPanel';
import { useExecuteCode } from '../hooks/useExecuteCode';
import { useWorkspaceStore } from '../state/workspaceStore';

/**
 * Phase 2: the editor is now file-centric rather than language-centric.
 *
 * Each file (from the File Explorer / workspaceStore) owns its own
 * `content` and `language`. This replaces Phase 2a's standalone
 * `codeByLanguage: Record<language, code>` map in this component with
 * the more general per-file storage in workspaceStore — exactly the
 * extension that Phase 2a's comments said would happen, not a
 * from-scratch replacement of the idea.
 *
 * The LanguageSelector still works exactly as before, except it now
 * edits the ACTIVE FILE's language (like VS Code's language-mode
 * picker) instead of switching between independent language "slots".
 */
export function EditorPage() {
  const nodes = useWorkspaceStore((s) => s.nodes);
  const activeFileId = useWorkspaceStore((s) => s.activeFileId);
  const setActiveFileContent = useWorkspaceStore((s) => s.setActiveFileContent);
  const setActiveFileLanguage = useWorkspaceStore((s) => s.setActiveFileLanguage);
  const clearActiveFileContent = useWorkspaceStore((s) => s.clearActiveFileContent);

  const activeFile = activeFileId ? nodes[activeFileId] : undefined;

  const { run, isRunning } = useExecuteCode();

  // Resizable editor/terminal with layout toggle
  const [layout, setLayout] = useState<'horizontal' | 'vertical'>('horizontal');
  const [panelSize, setPanelSize] = useState(60); // percentage
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging || !containerRef.current) return;

      const container = containerRef.current;
      const rect = container.getBoundingClientRect();

      let newSize: number;
      if (layout === 'horizontal') {
        // Resize vertically: update height
        newSize = ((e.clientY - rect.top) / rect.height) * 100;
      } else {
        // Resize horizontally: update width
        newSize = ((e.clientX - rect.left) / rect.width) * 100;
      }

      // Minimum 20% for each panel, 20% for other
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
    // Backend streaming support required for interactive stdin.
    // For now, programs run without stdin. Support for live input will be added
    // when the backend implements streaming execution (SSE/WebSocket).
    run(activeFile?.content ?? '', activeFile?.language ?? 'plaintext');
  };

  return (
    <div className="flex h-full gap-4 p-4">
      <FileExplorer />

      {activeFile ? (
        <>
          <section className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-neutral-400">{activeFile.name}</span>
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
                />
              </div>
            </div>

            {/* Resizable editor and output area */}
            <div 
              className={`flex min-h-0 flex-1 ${layout === 'horizontal' ? 'flex-col' : 'flex-row'}`}
              ref={containerRef}
            >
              {/* Editor */}
              <div 
                style={
                  layout === 'horizontal'
                    ? { height: `${panelSize}%` }
                    : { width: `${panelSize}%` }
                }
                className="flex min-h-0 min-w-0 flex-col overflow-hidden"
              >
                <CodeEditor
                  language={activeFile.language ?? 'plaintext'}
                  value={activeFile.content ?? ''}
                  onChange={setActiveFileContent}
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

              {/* Output Panel */}
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
        </>
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