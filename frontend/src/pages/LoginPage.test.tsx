// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { apiClient } from '../api/client';
import { useAuthStore } from '../state/authStore';
import { LoginPage } from './LoginPage';

describe('login role redirects', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  beforeEach(() => useAuthStore.setState({ user: null, adminVerified: false, isLoading: false, error: null }));

  const submitLogin = async () => {
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'person@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('Enter your password'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  };

  it('routes a database-backed admin role to the admin dashboard', async () => {
    vi.spyOn(apiClient, 'post').mockResolvedValue({ data: { access_token: 'admin-token', user_id: 'admin-id', display_name: 'Admin' } } as never);
    vi.spyOn(apiClient, 'get').mockImplementation((url) => Promise.resolve({ data: url === '/users/me' ? { roles: ['admin'] } : { authorized: true } }) as never);
    render(<MemoryRouter initialEntries={['/login']}><Routes><Route path="/login" element={<LoginPage />} /><Route path="/admin" element={<p>Admin dashboard</p>} /><Route path="/editor" element={<p>Editor workspace</p>} /></Routes></MemoryRouter>);
    await submitLogin();
    await waitFor(() => expect(screen.getByText('Admin dashboard')).toBeTruthy());
    expect(useAuthStore.getState().adminVerified).toBe(true);
  });

  it('keeps standard users in the editor workspace flow', async () => {
    vi.spyOn(apiClient, 'post').mockResolvedValue({ data: { access_token: 'member-token', user_id: 'member-id', display_name: 'Member' } } as never);
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: { roles: ['member'] } } as never);
    render(<MemoryRouter initialEntries={['/login']}><Routes><Route path="/login" element={<LoginPage />} /><Route path="/admin" element={<p>Admin dashboard</p>} /><Route path="/editor" element={<p>Editor workspace</p>} /></Routes></MemoryRouter>);
    await submitLogin();
    await waitFor(() => expect(screen.getByText('Editor workspace')).toBeTruthy());
    expect(screen.queryByText('Admin dashboard')).toBeNull();
  });

  it('does not grant a standard user admin access when Admin is selected', async () => {
    vi.spyOn(apiClient, 'post').mockResolvedValue({ data: { access_token: 'member-token', user_id: 'member-id', display_name: 'Member' } } as never);
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: { roles: ['member'] } } as never);
    render(<MemoryRouter initialEntries={['/login']}><Routes><Route path="/login" element={<LoginPage />} /><Route path="/admin" element={<p>Admin dashboard</p>} /><Route path="/editor" element={<p>Editor workspace</p>} /></Routes></MemoryRouter>);
    fireEvent.click(screen.getByLabelText('Admin'));
    await submitLogin();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('does not have administrator access'));
    expect(useAuthStore.getState().user).toBeNull();
    expect(screen.queryByText('Admin dashboard')).toBeNull();
  });
});
