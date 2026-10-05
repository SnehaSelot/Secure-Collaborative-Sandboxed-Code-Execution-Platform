import { describe, expect, it } from 'vitest';
import { getEditorDisplayOptions, getResolvedTheme } from './editorOptions';

describe('Monaco editor preferences', () => {
  it('resolves light and dark preferences consistently with the application theme', () => {
    expect(getResolvedTheme('light', false)).toBe('light');
    expect(getResolvedTheme('dark', true)).toBe('dark');
    expect(getResolvedTheme('system', true)).toBe('light');
    expect(getResolvedTheme('system', false)).toBe('dark');
  });

  it('maps persisted display preferences to Monaco options', () => {
    expect(
      getEditorDisplayOptions({
        fontSize: 18,
        fontFamily: 'cascadia',
        wordWrap: 'off',
        tabSize: 2,
        minimap: true,
        lineNumbers: false,
      }),
    ).toEqual({
      fontSize: 18,
      fontFamily: "'Cascadia Code', monospace",
      wordWrap: 'off',
      tabSize: 2,
      insertSpaces: true,
      minimap: { enabled: true },
      lineNumbers: 'off',
    });
  });
});
