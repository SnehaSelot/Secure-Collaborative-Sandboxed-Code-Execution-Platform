import { create } from 'zustand';

export type CreateItemMode = 'file' | 'folder';

interface CreateItemModalState {
  isOpen: boolean;
  mode: CreateItemMode;
  /** null = workspace root, matching workspaceStore's parentId convention. */
  parentId: string | null;

  open: (mode: CreateItemMode, parentId: string | null) => void;
  close: () => void;
}

/**
 * Kept separate from workspaceStore on purpose: this is transient UI
 * state ("is the create-item dialog open, and for what"), not workspace
 * data. Rendered once by FileExplorer.tsx; opened from ExplorerToolbar.tsx
 * (root) and FileTreeItem.tsx (inside a folder).
 */
export const useCreateItemModalStore = create<CreateItemModalState>((set) => ({
  isOpen: false,
  mode: 'file',
  parentId: null,

  open: (mode, parentId) => set({ isOpen: true, mode, parentId }),
  close: () => set({ isOpen: false }),
}));
