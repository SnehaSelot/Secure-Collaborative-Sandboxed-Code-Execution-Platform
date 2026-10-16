// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { LandingPage } from './LandingPage';

describe('public landing page', () => {
  it('shows the public hero, feature sections, and valid navigation actions', () => {
    render(<MemoryRouter><LandingPage /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: /secure code execution without compromising collaboration/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: /start coding/i }).getAttribute('href')).toBe('/login');
    expect(screen.getByRole('link', { name: /login/i }).getAttribute('href')).toBe('/login');
    expect(screen.getByText('Sandboxed Execution')).toBeTruthy();
    expect(screen.getByText('Audit & Monitoring')).toBeTruthy();
  });
});
