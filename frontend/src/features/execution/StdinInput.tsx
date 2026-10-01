import { useExecutionStore } from "../../state/executionStore";
import { useLimits } from "../../hooks/useLimits";
import { MAX_STDIN_CHARS } from "../../config/constants";

/**
 * Sits above/beside OutputPanel.tsx. Value lives in executionStore (see
 * that file's comment on `stdin`) so useExecuteCode.ts can read it at
 * run time without this component needing to pass anything up through
 * EditorPage.tsx. Left blank, a run behaves exactly as it did before
 * stdin support existed — see useExecuteCode.ts.
 */
export function StdinInput() {
  const stdin = useExecutionStore((s) => s.stdin);
  const setStdin = useExecutionStore((s) => s.setStdin);
  const isRunning = useExecutionStore((s) => s.isRunning);
  const { limits } = useLimits();

  const maxChars = limits?.max_stdin_chars ?? MAX_STDIN_CHARS;

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-white/10 bg-neutral-900/60 p-3">
      <div className="flex items-center justify-between">
        <label
          htmlFor="stdin-input"
          className="text-xs font-medium tracking-wide text-neutral-400 uppercase"
        >
          Stdin <span className="normal-case text-neutral-600">(optional)</span>
        </label>
        <span className="text-[10px] text-neutral-500 font-mono">
          {stdin.length.toLocaleString()} / {maxChars.toLocaleString()}
        </span>
      </div>
      <textarea
        id="stdin-input"
        value={stdin}
        onChange={(e) => setStdin(e.target.value)}
        maxLength={maxChars}
        disabled={isRunning}
        placeholder="Input passed to the program, e.g. lines it will read()"
        rows={3}
        spellCheck={false}
        className="w-full resize-y rounded-md border border-white/10 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-emerald-500/50 disabled:opacity-50"
      />
    </div>
  );
}
