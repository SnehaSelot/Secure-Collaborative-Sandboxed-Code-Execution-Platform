// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { apiClient } from '../api/client';
import { useAuthStore } from '../state/authStore';
import { RequireAdmin } from './RequireAdmin';

describe('RequireAdmin', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  beforeEach(() => useAuthStore.setState({ user: null, adminVerified: false, isLoading: false, error: null }));

  it('redirects unauthenticated visitors to login', () => {
    render(<MemoryRouter initialEntries={['/admin']}><Routes><Route path="/admin" element={<RequireAdmin><p>Admin content</p></RequireAdmin>} /><Route path="/login" element={<p>Login page</p>} /></Routes></MemoryRouter>);
    expect(screen.getByText('Login page')).toBeTruthy();
  });

  it('hides admin content and redirects a standard user after a server 403', async () => {
    useAuthStore.setState({ user: { id: 'member', displayName: 'Member', token: 'member-token', roles: ['member'] } });
    vi.spyOn(apiClient, 'get').mockRejectedValue({ isAxiosError: true, response: { status: 403 } });
    render(<MemoryRouter initialEntries={['/admin']}><Routes><Route path="/admin" element={<RequireAdmin><p>Admin content</p></RequireAdmin>} /><Route path="/editor" element={<p>Editor page</p>} /></Routes></MemoryRouter>);
    expect(screen.queryByText('Admin content')).toBeNull();
    await waitFor(() => expect(screen.getByText('Editor page')).toBeTruthy());
  });

  it('renders protected content only after the backend confirms admin access', async () => {
    useAuthStore.setState({ user: { id: 'admin', displayName: 'Admin', token: 'admin-token', roles: ['admin'] } });
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: { authorized: true } } as never);
    render(<MemoryRouter initialEntries={['/admin']}><Routes><Route path="/admin" element={<RequireAdmin><p>Admin content</p></RequireAdmin>} /></Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Admin content')).toBeTruthy());
  });
});
