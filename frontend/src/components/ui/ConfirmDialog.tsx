import { useEffect, useRef } from 'react';
import { useConfirmDialogStore } from '../../state/confirmDialogStore';

/**
 * Replaces window.confirm() app-wide. Rendered once by MainLayout.tsx;
 * opened via useConfirmDialogStore from FileTreeItem.tsx (delete) and
 * SessionsPage.tsx (restore, delete).
 */
export function ConfirmDialog() {
  const isOpen = useConfirmDialogStore((s) => s.isOpen);
  const title = useConfirmDialogStore((s) => s.title);
  const message = useConfirmDialogStore((s) => s.message);
  const confirmLabel = useConfirmDialogStore((s) => s.confirmLabel);
  const cancelLabel = useConfirmDialogStore((s) => s.cancelLabel);
  const destructive = useConfirmDialogStore((s) => s.destructive);
  const onConfirm = useConfirmDialogStore((s) => s.onConfirm);
  const close = useConfirmDialogStore((s) => s.close);

  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isOpen) {
      const id = requestAnimationFrame(() => confirmButtonRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  function handleConfirm() {
    onConfirm();
    close();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[20vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      onKeyDown={handleKeyDown}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="w-full max-w-sm rounded-lg border border-white/10 bg-neutral-900 shadow-xl"
      >
        <div className="border-b border-white/10 px-4 py-3">
          <h2 id="confirm-dialog-title" className="text-sm font-medium text-neutral-200">
            {title}
          </h2>
        </div>

        <div className="px-4 py-3">
          <p className="text-sm text-neutral-400">{message}</p>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-white/10 px-4 py-3">
          <button
            type="button"
            onClick={close}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-400 transition hover:bg-white/5 hover:text-neutral-200"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmButtonRef}
            type="button"
            onClick={handleConfirm}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
              destructive
                ? 'bg-red-500 text-neutral-950 hover:bg-red-400'
                : 'bg-emerald-500 text-neutral-950 hover:bg-emerald-400'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}