import { useEffect, useRef, useState } from 'react';
import { useCreateItemModalStore } from '../../state/createItemModalStore';
import { useWorkspaceStore } from '../../state/workspaceStore';
import { useToastStore } from '../../state/toastStore';

/**
 * Replaces window.prompt for New File / New Folder. Rename now uses an
 * inline editable input (FileTreeItem.tsx) and Delete uses ConfirmDialog.tsx
 * — no native prompt/confirm/alert remain anywhere in the Explorer.
 * Rendered once, globally, by FileExplorer.tsx; opened via
 * useCreateItemModalStore from ExplorerToolbar.tsx (root) and
 * FileTreeItem.tsx (inside a folder).
 */
export function CreateItemModal() {
  const isOpen = useCreateItemModalStore((s) => s.isOpen);
  const mode = useCreateItemModalStore((s) => s.mode);
  const parentId = useCreateItemModalStore((s) => s.parentId);
  const close = useCreateItemModalStore((s) => s.close);

  const nodes = useWorkspaceStore((s) => s.nodes);
  const createFile = useWorkspaceStore((s) => s.createFile);
  const createFolder = useWorkspaceStore((s) => s.createFolder);
  const addToast = useToastStore((s) => s.addToast);

  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset + autofocus every time the modal opens.
  useEffect(() => {
    if (isOpen) {
      setName('');
      setError(null);
      // Focus after the element has actually painted.
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const label = mode === 'file' ? 'file' : 'folder';
  const placeholder = mode === 'file' ? 'main.py' : 'src';

  function validate(trimmed: string): string | null {
    if (!trimmed) return `Enter a ${label} name.`;
    if (/\s/.test(trimmed) && trimmed !== trimmed.trim()) return `Name can't start or end with whitespace.`;
    if (trimmed.includes('/') || trimmed.includes('\\')) return `Name can't contain "/" or "\\".`;
    if (trimmed === '.' || trimmed === '..') return `"${trimmed}" is not a valid name.`;

    const siblingNames = Object.values(nodes)
      .filter((n) => n.parentId === parentId)
      .map((n) => n.name.toLowerCase());
    if (siblingNames.includes(trimmed.toLowerCase())) {
      return `A ${label === 'file' ? 'file or folder' : 'file or folder'} named "${trimmed}" already exists here.`;
    }
    return null;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    const validationError = validate(trimmed);
    if (validationError) {
      setError(validationError);
      return;
    }

    if (mode === 'file') {
      createFile(parentId, trimmed);
    } else {
      createFolder(parentId, trimmed);
    }
    addToast('success', `Created ${label} "${trimmed}".`);
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
    >
      <form
        onSubmit={handleSubmit}
        onKeyDown={handleKeyDown}
        className="w-full max-w-sm rounded-lg border border-white/10 bg-neutral-900 shadow-xl"
      >
        <div className="border-b border-white/10 px-4 py-3">
          <h2 className="text-sm font-medium text-neutral-200">
            New {label}
          </h2>
        </div>

        <div className="px-4 py-3">
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError(null);
            }}
            placeholder={placeholder}
            aria-label={`New ${label} name`}
            aria-invalid={error ? 'true' : 'false'}
            className={`w-full rounded-md border bg-neutral-950 px-3 py-1.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 ${
              error
                ? 'border-red-500/50 focus:border-red-500/70'
                : 'border-white/10 focus:border-emerald-500/50'
            }`}
          />
          {error && <p className="mt-1.5 text-xs text-red-400">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-white/10 px-4 py-3">
          <button
            type="button"
            onClick={close}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-400 transition hover:bg-white/5 hover:text-neutral-200"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-medium text-neutral-950 transition hover:bg-emerald-400"
          >
            Create
          </button>
        </div>
      </form>
    </div>
  );
}