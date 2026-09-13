import { useState } from 'react';
import { useWorkspaceStore } from '../../state/workspaceStore';
import type { FileSystemNode } from '../../state/workspaceStore';
import { useCreateItemModalStore } from '../../state/createItemModalStore';
import { FileTree } from './FileTree';

interface FileTreeItemProps {
  node: FileSystemNode;
  depth: number;
}

const FOLDER_ICON = (
  <path
    d="M4 6a1 1 0 0 1 1-1h4l1.5 2H19a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6Z"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinejoin="round"
  />
);

const FILE_ICON = (
  <path
    d="M7 3h7l4 4v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM14 3v4h4"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinejoin="round"
  />
);

const CHEVRON_ICON = (
  <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
);

const PENCIL_ICON = (
  <path
    d="M4 20h4l10.5-10.5a2 2 0 0 0-4-4L4 16v4Z"
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinejoin="round"
  />
);

const TRASH_ICON = (
  <path
    d="M5 7h14M9 7V5h6v2M6 7l1 13h10l1-13"
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinecap="round"
    strokeLinejoin="round"
  />
);

const PLUS_FILE_ICON = (
  <path d="M7 3h7l4 4v14H7V3ZM12 11v6M9 14h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
);

const PLUS_FOLDER_ICON = (
  <path
    d="M4 6a1 1 0 0 1 1-1h4l1.5 2H19a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6ZM12 10v5M9.5 12.5h5"
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinecap="round"
  />
);

export function FileTreeItem({ node, depth }: FileTreeItemProps) {
  const activeFileId = useWorkspaceStore((s) => s.activeFileId);
  const openFile = useWorkspaceStore((s) => s.openFile);
  const toggleFolder = useWorkspaceStore((s) => s.toggleFolder);
  const renameNode = useWorkspaceStore((s) => s.renameNode);
  const deleteNode = useWorkspaceStore((s) => s.deleteNode);
  const openCreateModal = useCreateItemModalStore((s) => s.open);

  const [isHovered, setIsHovered] = useState(false);

  const isActive = node.type === 'file' && node.id === activeFileId;
  const isFolder = node.type === 'folder';

  function handlePrimaryClick() {
    if (isFolder) {
      toggleFolder(node.id);
    } else {
      openFile(node.id);
    }
  }

  function handleRename(e: React.MouseEvent) {
    e.stopPropagation();
    const next = window.prompt(`Rename "${node.name}" to:`, node.name);
    if (next && next.trim() && next.trim() !== node.name) {
      renameNode(node.id, next.trim());
    }
  }

  function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    const what = isFolder ? 'folder and everything inside it' : 'file';
    if (window.confirm(`Delete ${what} "${node.name}"? This cannot be undone.`)) {
      deleteNode(node.id);
    }
  }

  function handleNewFile(e: React.MouseEvent) {
    e.stopPropagation();
    openCreateModal('file', node.id);
  }

  function handleNewFolder(e: React.MouseEvent) {
    e.stopPropagation();
    openCreateModal('folder', node.id);
  }

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={handlePrimaryClick}
        onKeyDown={(e) => e.key === 'Enter' && handlePrimaryClick()}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        className={`group flex items-center gap-1.5 rounded py-1 pr-1 text-sm transition ${
          isActive
            ? 'bg-emerald-500/10 text-emerald-400'
            : 'text-neutral-300 hover:bg-white/5 hover:text-neutral-100'
        }`}
      >
        {isFolder ? (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            className={`shrink-0 transition-transform ${node.expanded ? 'rotate-90' : ''}`}
          >
            {CHEVRON_ICON}
          </svg>
        ) : (
          <span className="w-3 shrink-0" />
        )}

        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0">
          {isFolder ? FOLDER_ICON : FILE_ICON}
        </svg>

        <span className="flex-1 truncate">{node.name}</span>

        <span
          className={`flex shrink-0 items-center gap-0.5 transition-opacity ${
            isHovered ? 'opacity-100' : 'opacity-0'
          }`}
        >
          {isFolder && (
            <>
              <button
                type="button"
                onClick={handleNewFile}
                title="New file here"
                aria-label={`New file inside ${node.name}`}
                className="rounded p-1 text-neutral-500 hover:bg-white/10 hover:text-neutral-200"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  {PLUS_FILE_ICON}
                </svg>
              </button>
              <button
                type="button"
                onClick={handleNewFolder}
                title="New folder here"
                aria-label={`New folder inside ${node.name}`}
                className="rounded p-1 text-neutral-500 hover:bg-white/10 hover:text-neutral-200"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  {PLUS_FOLDER_ICON}
                </svg>
              </button>
            </>
          )}
          <button
            type="button"
            onClick={handleRename}
            title="Rename"
            aria-label={`Rename ${node.name}`}
            className="rounded p-1 text-neutral-500 hover:bg-white/10 hover:text-neutral-200"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              {PENCIL_ICON}
            </svg>
          </button>
          <button
            type="button"
            onClick={handleDelete}
            title="Delete"
            aria-label={`Delete ${node.name}`}
            className="rounded p-1 text-neutral-500 hover:bg-red-500/10 hover:text-red-400"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              {TRASH_ICON}
            </svg>
          </button>
        </span>
      </div>

      {isFolder && node.expanded && <FileTree parentId={node.id} depth={depth + 1} />}
    </div>
  );
}