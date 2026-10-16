// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionsStore } from './sessionsStore';

describe('account-scoped workspace snapshots', () => {
  beforeEach(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('glasshouse-sessions:')) localStorage.removeItem(key);
    }
    useSessionsStore.setState({ sessions: [], accountId: null });
  });

  it('isolates account snapshots across switching and clears only the active in-memory account on logout', () => {
    localStorage.setItem('glasshouse-sessions', JSON.stringify([{ id: 'legacy', name: 'Unscoped old data' }]));
    const store = useSessionsStore.getState();
    store.activateAccount('user-a');
    expect(useSessionsStore.getState().sessions).toEqual([]);
    useSessionsStore.getState().saveSession('A private snapshot');
    expect(useSessionsStore.getState().sessions.map((session) => session.name)).toEqual(['A private snapshot']);

    useSessionsStore.getState().activateAccount('user-b');
    expect(useSessionsStore.getState().sessions).toEqual([]);
    useSessionsStore.getState().saveSession('B private snapshot');
    window.dispatchEvent(new Event('glasshouse:account-logged-out'));
    expect(useSessionsStore.getState().sessions).toEqual([]);

    useSessionsStore.getState().activateAccount('user-a');
    expect(useSessionsStore.getState().sessions.map((session) => session.name)).toEqual(['A private snapshot']);
    useSessionsStore.getState().activateAccount('user-b');
    expect(useSessionsStore.getState().sessions.map((session) => session.name)).toEqual(['B private snapshot']);
    expect(localStorage.getItem('glasshouse-sessions:user-a')).not.toBeNull();
    expect(localStorage.getItem('glasshouse-sessions:user-b')).not.toBeNull();
    expect(localStorage.getItem('glasshouse-sessions')).not.toBeNull();
  });
});
