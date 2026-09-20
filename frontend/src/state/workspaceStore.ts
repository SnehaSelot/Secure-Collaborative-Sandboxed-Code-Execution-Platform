import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getLanguageTemplate, detectLanguageFromFilename } from '../config/languageTemplates';
import { DEFAULT_LANGUAGE } from '../config/constants';

export type NodeType = 'file' | 'folder';

export interface FileSystemNode {
  id: string;
  name: string;
  type: NodeType;
  parentId: string | null;
  /** Only meaningful for files. Undefined for folders. */
  language?: string;
  /** Only meaningful for files. Undefined for folders. */
  content?: string;
  /** Per-language code storage for switching between languages while preserving edits.
   * Key: language code (e.g., 'python', 'javascript')
   * Value: the code written for that language
   * Only meaningful for files. Undefined for folders.
   * Backward compatible: files without this field continue working (content is used as single storage).
   */
  codeByLanguage?: Record<string, string>;
  /** Only meaningful for folders — whether the tree shows its children. */
  expanded?: boolean;
}

interface WorkspaceState {
  nodes: Record<string, FileSystemNode>;
  activeFileId: string | null;

  createFile: (parentId: string | null, name: string) => string;
  createFolder: (parentId: string | null, name: string) => string;
  renameNode: (id: string, newName: string) => void;
  deleteNode: (id: string) => void;
  openFile: (id: string) => void;
  toggleFolder: (id: string) => void;
  setActiveFileContent: (content: string) => void;
  setActiveFileLanguage: (language: string) => void;
  clearActiveFileContent: () => void;
}

function makeId(): string {
  // crypto.randomUUID is available in all browsers this project targets —
  // no uuid package needed (per project rule: avoid unnecessary deps).
  return crypto.randomUUID();
}

/**
 * Recursively collects a node's id and every descendant's id, so
 * deleteNode can remove a folder and everything inside it in one pass.
 */
function collectIdsToDelete(nodes: Record<string, FileSystemNode>, rootId: string): string[] {
  const ids = [rootId];
  const children = Object.values(nodes).filter((n) => n.parentId === rootId);
  for (const child of children) {
    ids.push(...collectIdsToDelete(nodes, child.id));
  }
  return ids;
}

/**
 * Seeds the workspace with one starter file so the editor always has
 * something open on first load — matches the Phase 1 behavior of
 * opening with a working Python example.
 *
 * PERSISTENCE NOTE: persisted to localStorage via Zustand's `persist`
 * middleware (see the bottom of this file) — this is exactly the
 * upgrade path this comment used to describe as future work. Swapping
 * to real backend persistence later means replacing these actions'
 * bodies with API calls while keeping the same action names/signatures,
 * so FileExplorer.tsx and EditorPage.tsx would not need to change.
 */
function seedWorkspace(): { nodes: Record<string, FileSystemNode>; activeFileId: string } {
  const mainId = makeId();
  const template = getLanguageTemplate(DEFAULT_LANGUAGE);
  const mainFile: FileSystemNode = {
    id: mainId,
    name: 'main.py',
    type: 'file',
    parentId: null,
    language: DEFAULT_LANGUAGE,
    content: template,
    codeByLanguage: { [DEFAULT_LANGUAGE]: template },
  };
  return { nodes: { [mainId]: mainFile }, activeFileId: mainId };
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      ...seedWorkspace(),

      createFile: (parentId, name) => {
        const id = makeId();
        const language = detectLanguageFromFilename(name) ?? 'plaintext';
        const template = getLanguageTemplate(language);
        const node: FileSystemNode = {
          id,
          name,
          type: 'file',
          parentId,
          language,
          content: template,
          codeByLanguage: { [language]: template },
        };
        set((state) => ({
          nodes: { ...state.nodes, [id]: node },
          activeFileId: id,
        }));
        return id;
      },

      createFolder: (parentId, name) => {
        const id = makeId();
        const node: FileSystemNode = {
          id,
          name,
          type: 'folder',
          parentId,
          expanded: true,
        };
        set((state) => ({ nodes: { ...state.nodes, [id]: node } }));
        return id;
      },

      renameNode: (id, newName) => {
        set((state) => {
          const existing = state.nodes[id];
          if (!existing) return state;

          const updated: FileSystemNode = { ...existing, name: newName };

          // Re-detect language from the new extension for files, same as a
          // "New File" creation would — but only overwrite if something was
          // actually detected, so renaming "main.py" to "main" (no
          // extension) doesn't wipe a working language back to plaintext.
          if (existing.type === 'file') {
            const detected = detectLanguageFromFilename(newName);
            if (detected) {
              updated.language = detected;
            }
          }

          return { nodes: { ...state.nodes, [id]: updated } };
        });
      },

      deleteNode: (id) => {
        set((state) => {
          const idsToDelete = new Set(collectIdsToDelete(state.nodes, id));
          const nodes = { ...state.nodes };
          idsToDelete.forEach((nodeId) => delete nodes[nodeId]);

          const activeFileId = idsToDelete.has(state.activeFileId ?? '')
            ? null
            : state.activeFileId;

          return { nodes, activeFileId };
        });
      },

      openFile: (id) => {
        const node = get().nodes[id];
        if (node?.type === 'file') {
          set({ activeFileId: id });
        }
      },

      toggleFolder: (id) => {
        set((state) => {
          const existing = state.nodes[id];
          if (!existing || existing.type !== 'folder') return state;
          return {
            nodes: { ...state.nodes, [id]: { ...existing, expanded: !existing.expanded } },
          };
        });
      },

      setActiveFileContent: (content) => {
        set((state) => {
          if (!state.activeFileId) return state;
          const active = state.nodes[state.activeFileId];
          if (!active || !active.language) return state;
          // Save content to both convenience field and per-language storage
          const codeByLanguage = { ...(active.codeByLanguage || {}), [active.language]: content };
          return {
            nodes: { ...state.nodes, [state.activeFileId]: { ...active, content, codeByLanguage } },
          };
        });
      },

      setActiveFileLanguage: (language) => {
        set((state) => {
          if (!state.activeFileId) return state;
          const active = state.nodes[state.activeFileId];
          if (!active) return state;
          // When language changes, restore previously saved code for that language, or show template if new
          const codeByLanguage = active.codeByLanguage || {};
          const newContent = codeByLanguage[language] ?? getLanguageTemplate(language);
          // Update or initialize per-language storage if this is a new language
          const updatedCodeByLanguage = { ...codeByLanguage, [language]: newContent };
          return {
            nodes: { ...state.nodes, [state.activeFileId]: { ...active, language, content: newContent, codeByLanguage: updatedCodeByLanguage } },
          };
        });
      },

      clearActiveFileContent: () => {
        set((state) => {
          if (!state.activeFileId) return state;
          const active = state.nodes[state.activeFileId];
          if (!active) return state;
          // Also clear the per-language cache entry, or switching language
          // away and back would silently restore the pre-clear code.
          const codeByLanguage = active.language
            ? { ...(active.codeByLanguage || {}), [active.language]: '' }
            : active.codeByLanguage;
          return {
            nodes: { ...state.nodes, [state.activeFileId]: { ...active, content: '', codeByLanguage } },
          };
        });
      },
    }),
    { name: 'glasshouse-workspace' },
  ),
);