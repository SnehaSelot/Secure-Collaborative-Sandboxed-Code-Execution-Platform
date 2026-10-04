import type {
  FontFamilyPreference,
  TabSizePreference,
  ThemePreference,
  WordWrapPreference,
} from '../../state/preferencesStore';

export function getResolvedTheme(
  preference: ThemePreference,
  systemPrefersLight: boolean,
): 'light' | 'dark' {
  return preference === 'light' || (preference === 'system' && systemPrefersLight)
    ? 'light'
    : 'dark';
}

export interface EditorDisplayPreferences {
  fontSize: number;
  fontFamily: FontFamilyPreference;
  wordWrap: WordWrapPreference;
  tabSize: TabSizePreference;
  minimap: boolean;
  lineNumbers: boolean;
}

export function getEditorDisplayOptions({
  fontSize,
  fontFamily,
  wordWrap,
  tabSize,
  minimap,
  lineNumbers,
}: EditorDisplayPreferences) {
  return {
    fontSize,
    fontFamily: {
      system: 'monospace',
      consolas: 'Consolas, monospace',
      cascadia: "'Cascadia Code', monospace",
      courier: "'Courier New', monospace",
    }[fontFamily],
    wordWrap,
    tabSize,
    insertSpaces: true,
    minimap: { enabled: minimap },
    lineNumbers: lineNumbers ? ('on' as const) : ('off' as const),
  };
}
