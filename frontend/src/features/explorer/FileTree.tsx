import { useWorkspaceStore } from '../../state/workspaceStore';
import { FileTreeItem } from './FileTreeItem';

interface FileTreeProps {
  parentId: string | null;
  depth?: number;
}

/**
 * Renders one level of the tree — folders first, then files, both
 * alphabetical. Recurses into FileTreeItem for expanded folders, which
 * renders another FileTree for its own parentId. No node ever appears
 * twice: each node has exactly one parentId, so this is a simple tree,
 * not a graph.
 */
export function FileTree({ parentId, depth = 0 }: FileTreeProps) {
  const nodes = useWorkspaceStore((s) => s.nodes);

  const children = Object.values(nodes)
    .filter((n) => n.parentId === parentId)
    .sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'folder' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

  if (children.length === 0 && depth === 0) {
    return <p className="px-3 py-2 text-xs text-neutral-600">No files yet.</p>;
  }

  return (
    <div>
      {children.map((node) => (
        <FileTreeItem key={node.id} node={node} depth={depth} />
      ))}
    </div>
  );
}