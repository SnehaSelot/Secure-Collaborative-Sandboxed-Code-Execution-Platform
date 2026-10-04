// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  usePreferencesStore,
} from './preferencesStore';

describe('preferences store', () => {
  beforeEach(() => {
    localStorage.removeItem('glasshouse-preferences');
    usePreferencesStore.setState(DEFAULT_PREFERENCES);
  });

  it('starts with the documented editor and execution defaults', () => {
    const state = usePreferencesStore.getState();

    expect(state.theme).toBe('system');
    expect(state.fontSize).toBe(14);
    expect(state.fontFamily).toBe('system');
    expect(state.tabSize).toBe(4);
    expect(state.minimap).toBe(false);
    expect(state.lineNumbers).toBe(true);
    expect(state.defaultLanguage).toBe('python');
    expect(state.clearOutputBeforeRun).toBe(true);
    expect(state.interfaceDensity).toBe('comfortable');
  });

  it('persists changes without storing action functions', () => {
    usePreferencesStore.getState().setTheme('light');
    usePreferencesStore.getState().setFontSize(18);
    usePreferencesStore.getState().setMinimap(true);

    const persisted = JSON.parse(
      localStorage.getItem('glasshouse-preferences') ?? '{}',
    ) as { state: Record<string, unknown> };

    expect(persisted.state.theme).toBe('light');
    expect(persisted.state.fontSize).toBe(18);
    expect(persisted.state.minimap).toBe(true);
    expect(persisted.state.setTheme).toBeUndefined();
  });

  it('rehydrates saved preferences as it does on application startup', async () => {
    usePreferencesStore.getState().setTheme('light');
    usePreferencesStore.getState().setFontSize(19);
    const savedPreferences = localStorage.getItem('glasshouse-preferences');
    usePreferencesStore.setState(DEFAULT_PREFERENCES);
    if (savedPreferences) {
      localStorage.setItem('glasshouse-preferences', savedPreferences);
    }

    await usePreferencesStore.persist.rehydrate();

    expect(usePreferencesStore.getState()).toMatchObject({
      theme: 'light',
      fontSize: 19,
    });
  });

  it('restores editor defaults without changing execution preferences', () => {
    const state = usePreferencesStore.getState();
    state.setTheme('light');
    state.setDefaultLanguage('java');
    state.setFontSize(20);
    state.setLineNumbers(false);
    state.resetEditorPreferences();

    expect(usePreferencesStore.getState()).toMatchObject({
      theme: DEFAULT_PREFERENCES.theme,
      defaultLanguage: 'java',
      fontSize: DEFAULT_PREFERENCES.fontSize,
      lineNumbers: DEFAULT_PREFERENCES.lineNumbers,
      tabSize: DEFAULT_PREFERENCES.tabSize,
    });
  });

  it('resets all persisted preferences to defaults', () => {
    usePreferencesStore.getState().setTheme('light');
    usePreferencesStore.getState().setDefaultLanguage('java');
    usePreferencesStore.getState().setReducedMotion(true);
    usePreferencesStore.getState().resetPreferences();

    expect(usePreferencesStore.getState()).toMatchObject(DEFAULT_PREFERENCES);
    const persisted = JSON.parse(
      localStorage.getItem('glasshouse-preferences') ?? '{}',
    ) as { state: Record<string, unknown> };
    expect(persisted.state.theme).toBe(DEFAULT_PREFERENCES.theme);
    expect(persisted.state.defaultLanguage).toBe(DEFAULT_PREFERENCES.defaultLanguage);
    expect(persisted.state.reducedMotion).toBe(DEFAULT_PREFERENCES.reducedMotion);
  });
});
