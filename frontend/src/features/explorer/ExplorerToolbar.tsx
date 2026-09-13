import { useCreateItemModalStore } from '../../state/createItemModalStore';

const NEW_FILE_ICON = (
  <path d="M7 3h7l4 4v14H7V3ZM12 11v6M9 14h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
);

const NEW_FOLDER_ICON = (
  <path
    d="M4 6a1 1 0 0 1 1-1h4l1.5 2H19a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6ZM12 10v5M9.5 12.5h5"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
  />
);

/**
 * Creates files/folders at the workspace root. To create inside a
 * specific folder, use that folder's inline "+" buttons in
 * FileTreeItem.tsx instead.
 */
export function ExplorerToolbar() {
  const openCreateModal = useCreateItemModalStore((s) => s.open);

  function handleNewFile() {
    openCreateModal('file', null);
  }

  function handleNewFolder() {
    openCreateModal('folder', null);
  }

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={handleNewFile}
        title="New file"
        aria-label="New file"
        className="rounded p-1.5 text-neutral-400 transition hover:bg-white/10 hover:text-neutral-100"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          {NEW_FILE_ICON}
        </svg>
      </button>
      <button
        type="button"
        onClick={handleNewFolder}
        title="New folder"
        aria-label="New folder"
        className="rounded p-1.5 text-neutral-400 transition hover:bg-white/10 hover:text-neutral-100"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          {NEW_FOLDER_ICON}
        </svg>
      </button>
    </div>
  );
}