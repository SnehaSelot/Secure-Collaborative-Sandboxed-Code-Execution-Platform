// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES, usePreferencesStore } from '../state/preferencesStore';
import { useWorkspaceStore } from '../state/workspaceStore';
import { SettingsPage } from './SettingsPage';

vi.mock('../hooks/useLanguages', () => ({
  useLanguages: () => ({
    languages: ['python', 'java'],
    loading: false,
    isFallback: false,
  }),
}));

vi.mock('../hooks/useLimits', () => ({
  useLimits: () => ({
    limits: { timeout_seconds: { python: 15, java: 30 } },
    loading: false,
    error: null,
  }),
}));

describe('Settings page integration', () => {
  beforeEach(() => {
    localStorage.removeItem('glasshouse-preferences');
    usePreferencesStore.setState(DEFAULT_PREFERENCES);
  });

  it('updates persisted editor, execution, and accessibility preferences', () => {
    render(<SettingsPage />);

    fireEvent.change(screen.getByLabelText('Application and editor theme'), {
      target: { value: 'light' },
    });
    fireEvent.change(screen.getByLabelText('Default language for new files'), {
      target: { value: 'java' },
    });
    fireEvent.click(screen.getByLabelText('Clear output before each run'));
    fireEvent.click(screen.getByLabelText('Reduce motion'));

    expect(usePreferencesStore.getState()).toMatchObject({
      theme: 'light',
      defaultLanguage: 'java',
      clearOutputBeforeRun: false,
      reducedMotion: true,
    });
    const defaultFileId = useWorkspaceStore.getState().createFile(null, 'untitled');
    const pythonFileId = useWorkspaceStore.getState().createFile(null, 'script.py');
    expect(useWorkspaceStore.getState().nodes[defaultFileId].language).toBe('java');
    expect(useWorkspaceStore.getState().nodes[pythonFileId].language).toBe('python');
    expect(screen.getByText(/python: 15s · java: 30s/)).toBeTruthy();
  });

  it('keeps collaboration controls disabled in local-only mode', () => {
    render(<SettingsPage />);

    expect(screen.getByLabelText('Show collaborator cursors')).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByLabelText('Show participant names')).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByLabelText('Collaboration notifications')).toHaveProperty(
      'disabled',
      true,
    );
  });
});
