// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AdminPage } from './AdminPage';
import { apiClient } from '../api/client';
import { useAuthStore } from '../state/authStore';

describe('admin authorization', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  beforeEach(() => useAuthStore.setState({ user: { id: 'member-id', displayName: 'Member', token: 'member-token' }, adminVerified: false, isLoading: false, error: null }));

  it('denies a normal account when the backend authorization check returns 403', async () => {
    vi.spyOn(apiClient, 'get').mockRejectedValue({ isAxiosError: true, response: { status: 403 } });
    render(<MemoryRouter initialEntries={['/admin']}><Routes><Route path="/admin" element={<AdminPage />} /><Route path="/editor" element={<p>Editor page</p>} /></Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Editor page')).toBeTruthy());
    expect(useAuthStore.getState().adminVerified).toBe(false);
  });
});

describe('admin overview', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  beforeEach(() => useAuthStore.setState({ user: { id: 'admin-id', displayName: 'Admin', token: 'admin-token' }, adminVerified: true, isLoading: false, error: null }));

  it('renders overview metrics and recent audit data from the API', async () => {
    const get = vi.spyOn(apiClient, 'get').mockImplementation(async (url) => {
      if (String(url).startsWith('/admin/overview')) return { data: { active_sessions: 2, recent_sessions: 4, hibernated_sessions: 1, closed_sessions: 3, total_executions: 10, successful_executions: 8, finished_executions: 10, execution_success_rate: 80, execution_activity: [{ day: '2026-10-18', executions: 3, successful_executions: 2 }] } } as never;
      if (url === '/admin/sessions') return { data: [] } as never;
      if (String(url).startsWith('/admin/audit')) return { data: [{ id: 1, created_at: '2026-10-19T10:00:00Z', user_id: 'admin-id', user_name: 'Admin', user_email: 'admin@example.test', session_id: null, session_name: null, action: 'admin.user.update', entity_type: 'user', entity_id: 'user-id', metadata: null, risk_score: null, risk_decision: null }] } as never;
      if (url === '/admin/users') return { data: [] } as never;
      if (url === '/admin/health') return { data: { database: 'online', collaboration: 'online', collaboration_clients: 1 } } as never;
      if (url === '/health') return { data: { status: 'ok' } } as never;
      throw new Error(`Unexpected API request: ${String(url)}`);
    });

    render(<MemoryRouter initialEntries={['/admin']}><Routes><Route path="/admin" element={<AdminPage />} /></Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Sessions created · 7d')).toBeTruthy());
    expect(screen.getByText('Execution activity')).toBeTruthy();
    expect(screen.getByText('Session status')).toBeTruthy();
    expect(screen.getByText('Execution outcomes')).toBeTruthy();
    expect(screen.getByText('System health')).toBeTruthy();
    expect(screen.getAllByText('Healthy')).toHaveLength(3);
    expect(screen.getByText('admin.user.update')).toBeTruthy();
    expect(screen.getByRole('link', { name: /view audit trail/i })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Chart range'), { target: { value: '14' } });
    await waitFor(() => expect(get).toHaveBeenCalledWith('/admin/overview?days=14', expect.anything()));
  });

  it('shows an empty activity state when the API returns zero-filled days', async () => {
    vi.spyOn(apiClient, 'get').mockImplementation(async (url) => {
      if (String(url).startsWith('/admin/overview')) return { data: { active_sessions: 0, recent_sessions: 0, hibernated_sessions: 0, closed_sessions: 0, total_executions: 0, successful_executions: 0, finished_executions: 0, execution_success_rate: null, execution_activity: Array.from({ length: 7 }, (_, index) => ({ day: `2026-10-${String(index + 13).padStart(2, '0')}`, executions: 0, successful_executions: 0 })) } } as never;
      if (url === '/admin/sessions' || url === '/admin/users' || String(url).startsWith('/admin/audit')) return { data: [] } as never;
      if (url === '/admin/health') return { data: { database: 'online', collaboration: 'disabled', collaboration_clients: null } } as never;
      if (url === '/health') return { data: { status: 'ok' } } as never;
      throw new Error(`Unexpected API request: ${String(url)}`);
    });

    render(<MemoryRouter initialEntries={['/admin']}><Routes><Route path="/admin" element={<AdminPage />} /></Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('No execution records in the selected 7-day range.')).toBeTruthy());
    expect(screen.queryByRole('group', { name: /execution activity for the last/i })).toBeNull();
    expect(screen.getByText('Degraded')).toBeTruthy();
  });
});
