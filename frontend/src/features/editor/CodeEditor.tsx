import Editor from '@monaco-editor/react';
import { useEffect, useState } from 'react';
import { usePreferencesStore } from '../../state/preferencesStore';

interface CodeEditorProps {
  language: string;
  value: string;
  onChange: (value: string) => void;
}

/**
 * Solo-editing Monaco instance. Deliberately NOT wired to Yjs yet —
 * per project rules, collaboration only gets added once the
 * collab-gateway backend actually exists (Phase 5). Keeping this
 * component's props simple (controlled value/onChange) means the
 * future y-monaco MonacoBinding can be added in the `onMount` handler
 * without changing this component's public interface.
 */
export function CodeEditor({ language, value, onChange }: CodeEditorProps) {
  const themePreference = usePreferencesStore((state) => state.theme);
  const fontSize = usePreferencesStore((state) => state.fontSize);
  const wordWrap = usePreferencesStore((state) => state.wordWrap);
  const tabSize = usePreferencesStore((state) => state.tabSize);
  const [editorTheme, setEditorTheme] = useState<'light' | 'vs-dark'>('vs-dark');

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const applyTheme = () => {
      setEditorTheme(
        themePreference === 'light' || (themePreference === 'system' && media.matches)
          ? 'light'
          : 'vs-dark',
      );
    };

    applyTheme();
    media.addEventListener('change', applyTheme);
    return () => media.removeEventListener('change', applyTheme);
  }, [themePreference]);

  return (
    <div className="h-full w-full overflow-hidden rounded-lg border border-white/10">
      <Editor
        height="100%"
        language={language}
        value={value}
        theme={editorTheme}
        onChange={(next) => onChange(next ?? '')}
        options={{
          minimap: { enabled: false },
          fontSize,
          wordWrap,
          tabSize,
          insertSpaces: true,
          lineNumbers: 'on',
          automaticLayout: true,
          scrollBeyondLastLine: false,
          padding: { top: 12 },
          fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, monospace",
          // Explicit, not just relying on the default: without these,
          // a stale Monaco model from a previous mount can occasionally
          // come back read-only after a fast file/language switch.
          readOnly: false,
          domReadOnly: false,
        }}
      />
    </div>
  );
}