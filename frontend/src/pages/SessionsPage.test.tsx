// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionsPage } from './SessionsPage';
import { useAuthStore } from '../state/authStore';
import { useSessionsStore } from '../state/sessionsStore';

describe('SessionsPage account isolation', () => {
  afterEach(cleanup);
  beforeEach(() => {
    for (const key of Object.keys(localStorage)) if (key.startsWith('glasshouse-sessions:')) localStorage.removeItem(key);
    useAuthStore.setState({ user: { id: 'account-a', displayName: 'A', token: 'token-a' }, adminVerified: false, isLoading: false, error: null });
    useSessionsStore.setState({ accountId: null, sessions: [] });
    useSessionsStore.getState().activateAccount('account-a');
    useSessionsStore.getState().saveSession('A workspace');
    useSessionsStore.getState().activateAccount('account-b');
    useSessionsStore.getState().saveSession('B workspace');
    useSessionsStore.getState().activateAccount('account-a');
  });

  it('switches to the second user’s own snapshots and clears the visible list on logout', async () => {
    render(<SessionsPage />);
    expect(screen.getByText('A workspace')).toBeTruthy();
    expect(screen.queryByText('B workspace')).toBeNull();

    act(() => useAuthStore.setState({ user: { id: 'account-b', displayName: 'B', token: 'token-b' } }));
    await waitFor(() => expect(screen.getByText('B workspace')).toBeTruthy());
    expect(screen.queryByText('A workspace')).toBeNull();

    act(() => useAuthStore.getState().logout());
    await waitFor(() => expect(screen.queryByText('B workspace')).toBeNull());
    expect(localStorage.getItem('glasshouse-sessions:account-a')).not.toBeNull();
    expect(localStorage.getItem('glasshouse-sessions:account-b')).not.toBeNull();
  });
});
