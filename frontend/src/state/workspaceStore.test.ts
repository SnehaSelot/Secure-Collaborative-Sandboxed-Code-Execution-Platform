// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkspaceStore } from './workspaceStore';

describe('account-scoped private workspaces', () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.getState().clearActiveAccount();
  });

  it('isolates account files across logout and restores each account without touching legacy/shared data', () => {
    localStorage.setItem('glasshouse-workspace', JSON.stringify({ secret: 'unassigned legacy data' }));

    const workspace = useWorkspaceStore.getState();
    workspace.activateAccount('user-a');
    const fileA = useWorkspaceStore.getState().createFile(null, 'private-a.py');
    useWorkspaceStore.getState().setFileContent(fileA, 'print("A")');

    window.dispatchEvent(new Event('glasshouse:account-logged-out'));
    expect(useWorkspaceStore.getState().nodes[fileA]).toBeUndefined();

    useWorkspaceStore.getState().activateAccount('user-b');
    expect(Object.values(useWorkspaceStore.getState().nodes).some((file) => file.name === 'private-a.py')).toBe(false);
    const fileB = useWorkspaceStore.getState().createFile(null, 'private-b.py');
    useWorkspaceStore.getState().setFileContent(fileB, 'print("B")');

    window.dispatchEvent(new Event('glasshouse:account-logged-out'));
    useWorkspaceStore.getState().activateAccount('user-a');
    expect(useWorkspaceStore.getState().nodes[fileA]?.content).toBe('print("A")');
    expect(useWorkspaceStore.getState().nodes[fileB]).toBeUndefined();
    expect(localStorage.getItem('glasshouse-workspace')).toContain('unassigned legacy data');
    expect(localStorage.getItem('glasshouse-workspace:user-a')).toContain('private-a.py');
    expect(localStorage.getItem('glasshouse-workspace:user-b')).toContain('private-b.py');
  });
});
