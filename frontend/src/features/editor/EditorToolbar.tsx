interface EditorToolbarProps {
  onRun: () => void;
  onClear: () => void;
  isRunning: boolean;
}

/**
 * Format is intentionally disabled — there is no formatting endpoint
 * or in-browser formatter wired up yet. Showing it as a disabled button
 * with a clear tooltip is preferable to hiding it entirely, since the
 * requirement is to design for the complete feature set without
 * pretending unfinished pieces work.
 */
export function EditorToolbar({ onRun, onClear, isRunning }: EditorToolbarProps) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onRun}
        disabled={isRunning}
        className="flex items-center gap-2 rounded-md bg-emerald-500 px-4 py-1.5 text-sm font-medium text-neutral-950 transition hover:bg-emerald-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 disabled:cursor-not-allowed disabled:bg-emerald-500/40"
      >
        {isRunning ? (
          <>
            <svg
              className="h-3.5 w-3.5 animate-spin"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <circle
                cx="12"
                cy="12"
                r="9"
                stroke="currentColor"
                strokeWidth="3"
                strokeOpacity="0.3"
              />
              <path
                d="M21 12a9 9 0 0 0-9-9"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
              />
            </svg>
            Running…
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
        disabled
        title="Code formatting is not implemented yet"
        className="cursor-not-allowed rounded-md border border-white/5 px-3 py-1.5 text-sm text-neutral-600"
      >
        Format
      </button>
    </div>
  );
}