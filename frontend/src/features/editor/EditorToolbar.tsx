interface EditorToolbarProps {
  onRun: () => void;
  onStop: () => void;
  onClear: () => void;
  onFormat: () => void;
  isRunning: boolean;
  /** True only for languages formatCode.ts can actually format
   *  client-side today (currently just 'javascript'). */
  canFormat: boolean;
}

export function EditorToolbar({
  onRun,
  onStop,
  onClear,
  onFormat,
  isRunning,
  canFormat,
}: EditorToolbarProps) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={isRunning ? onStop : onRun}
        className={`flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 ${
          isRunning
            ? 'bg-red-500/90 text-neutral-950 hover:bg-red-500'
            : 'bg-emerald-500 text-neutral-950 hover:bg-emerald-400'
        }`}
      >
        {isRunning ? (
          <>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="1.5" />
            </svg>
            Stop
          </>
        ) : (
          <>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8 5v14l11-7z" />
            </svg>
            Run
          </>
        )}
      </button>

      <button
        type="button"
        onClick={onClear}
        disabled={isRunning}
        className="rounded-md border border-white/10 px-3 py-1.5 text-sm text-neutral-300 transition hover:bg-white/5 hover:text-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Clear
      </button>

      <button
        type="button"
        onClick={onFormat}
        disabled={isRunning || !canFormat}
        title={
          canFormat
            ? 'Format this file'
            : "Formatting isn't available for this language yet"
        }
        className="rounded-md border border-white/10 px-3 py-1.5 text-sm text-neutral-300 transition hover:bg-white/5 hover:text-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-500 disabled:cursor-not-allowed disabled:border-white/5 disabled:text-neutral-600 disabled:hover:bg-transparent"
      >
        Format
      </button>
    </div>
  );
}