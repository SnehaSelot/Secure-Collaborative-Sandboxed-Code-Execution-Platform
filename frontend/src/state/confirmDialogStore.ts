import { create } from 'zustand';

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button red — use for anything irreversible. */
  destructive?: boolean;
  onConfirm: () => void;
}

interface ConfirmDialogState extends ConfirmOptions {
  isOpen: boolean;
  open: (options: ConfirmOptions) => void;
  close: () => void;
}

/**
 * Single global confirm dialog, opened from anywhere (FileTreeItem.tsx's
 * delete, SessionsPage.tsx's restore/delete) instead of window.confirm().
 * Rendered once by MainLayout.tsx so every route shares it.
 */
export const useConfirmDialogStore = create<ConfirmDialogState>((set) => ({
  isOpen: false,
  title: '',
  message: '',
  confirmLabel: 'Confirm',
  cancelLabel: 'Cancel',
  destructive: false,
  onConfirm: () => {},

  open: (options) =>
    set({
      isOpen: true,
      confirmLabel: 'Confirm',
      cancelLabel: 'Cancel',
      destructive: false,
      ...options,
    }),
  close: () => set({ isOpen: false }),
}));