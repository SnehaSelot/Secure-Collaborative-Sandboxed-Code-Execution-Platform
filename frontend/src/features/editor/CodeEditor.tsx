import Editor from '@monaco-editor/react';

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
  return (
    <div className="h-full w-full overflow-hidden rounded-lg border border-white/10">
      <Editor
        height="100%"
        language={language}
        value={value}
        theme="vs-dark"
        onChange={(next) => onChange(next ?? '')}
        options={{
          minimap: { enabled: false },
          fontSize: 14,
          lineNumbers: 'on',
          automaticLayout: true,
          scrollBeyondLastLine: false,
          padding: { top: 12 },
          fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, monospace",
        }}
      />
    </div>
  );
}