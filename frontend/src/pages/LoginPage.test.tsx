// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LoginPage } from './LoginPage';
import { useAuthStore } from '../state/authStore';
import { apiClient } from '../api/client';

describe('login page', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: null, adminVerified: false, isLoading: false, error: null });
  });

  it('uses the existing login contract and returns to the intended route', async () => {
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: { access_token: 'test-token', user_id: 'user-id', display_name: 'Ada' } } as never);
    render(<MemoryRouter initialEntries={[{ pathname: '/login', state: { from: { pathname: '/sessions' } } }]}><Routes><Route path="/login" element={<LoginPage />} /><Route path="/sessions" element={<p>Sessions destination</p>} /></Routes></MemoryRouter>);

    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'ADA@example.com' } });
    fireEvent.change(screen.getByPlaceholderText(/enter your password/i), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await screen.findByText('Sessions destination');
    expect(post).toHaveBeenCalledWith('/auth/login', { email: 'ada@example.com', password: 'password123' });
    expect(useAuthStore.getState().user).toMatchObject({ id: 'user-id', displayName: 'Ada', token: 'test-token' });
    post.mockRestore();
  });

  it('renders useful API errors and does not grant admin access from the role preference', async () => {
    vi.spyOn(apiClient, 'post').mockRejectedValueOnce({ isAxiosError: true, response: { status: 401, data: { detail: 'Invalid credentials' } } });
    render(<MemoryRouter><LoginPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByPlaceholderText(/enter your password/i), { target: { value: 'incorrect' } });
    fireEvent.click(screen.getByLabelText('Admin'));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/invalid credentials/i));
    expect(useAuthStore.getState().adminVerified).toBe(false);
    vi.restoreAllMocks();
  });
});
