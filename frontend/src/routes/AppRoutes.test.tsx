// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './RequireAuth';
import { useAuthStore } from '../state/authStore';

describe('protected routes', () => {
  beforeEach(() => useAuthStore.setState({ user: null, adminVerified: false, isLoading: false, error: null }));

  it('redirects an unauthenticated visitor to sign in', () => {
    render(<MemoryRouter initialEntries={['/sessions']}><Routes><Route path="/sessions" element={<RequireAuth><p>Private sessions</p></RequireAuth>} /><Route path="/login" element={<p>Sign-in page</p>} /></Routes></MemoryRouter>);
    expect(screen.getByText('Sign-in page')).toBeTruthy();
  });
});
