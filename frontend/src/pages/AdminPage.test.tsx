// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
