// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { UserProfileMenu } from './UserProfileMenu';
import { useAuthStore } from '../../state/authStore';

describe('profile dropdown', () => {
  afterEach(cleanup);
  beforeEach(() => useAuthStore.setState({ user: { id: 'u-1', displayName: 'Ada Lovelace', email: 'ada@example.com', token: 'secret-test-token' }, adminVerified: false, isLoading: false, error: null }));

  it('portals above the layout, shows real identity, closes with Escape, and hides admin navigation for a member', () => {
    render(<MemoryRouter><Routes><Route path="*" element={<><div data-testid="editor-layout" className="overflow-hidden"><UserProfileMenu /></div><div id="destination" /></>} /></Routes></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'User menu' }));
    const menu = screen.getByRole('menu', { name: 'User account' });
    expect(document.body.lastElementChild).toBe(menu);
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('ada@example.com')).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /admin dashboard/i })).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'User menu' }));
  });

  it('closes when clicking outside the menu', () => {
    render(<MemoryRouter><><UserProfileMenu /><button type="button">Outside</button></></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'User menu' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
