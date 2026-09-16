import { ExplorerToolbar } from './ExplorerToolbar';
import { FileTree } from './FileTree';
import { CreateItemModal } from '../../components/ui/CreateItemModal';

/**
 * Sits INSIDE the editor workspace, to the left of the code editor —
 * distinct from the app-level Sidebar (components/layout/Sidebar.tsx),
 * which stays untouched and keeps its own nav (Editor/Sessions/etc).
 * This is GlassHouse's equivalent of VS Code's file explorer panel.
 */
export function FileExplorer() {
  return (
    <aside className="flex w-56 shrink-0 flex-col rounded-lg border border-white/10 bg-neutral-900/60 max-md:hidden">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-xs font-medium tracking-wide text-neutral-400 uppercase">
          Explorer
        </span>
        <ExplorerToolbar />
      </div>
      <div className="flex-1 overflow-auto py-1">
        <FileTree parentId={null} />
      </div>
      <CreateItemModal />
    </aside>
  );
}