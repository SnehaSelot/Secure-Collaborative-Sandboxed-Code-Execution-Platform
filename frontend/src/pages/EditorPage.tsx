import { useState } from 'react';
import { CodeEditor } from '../features/editor/CodeEditor';
import { LanguageSelector } from '../features/editor/LanguageSelector';
import { EditorToolbar } from '../features/editor/EditorToolbar';
import { OutputPanel } from '../features/execution/OutputPanel';
import { useExecuteCode } from '../hooks/useExecuteCode';
import { DEFAULT_CODE, DEFAULT_LANGUAGE } from '../config/constants';

export function EditorPage() {
  const [language, setLanguage] = useState(DEFAULT_LANGUAGE);
  const [code, setCode] = useState(DEFAULT_CODE);
  const { run, isRunning } = useExecuteCode();

  return (
    <div className="flex h-full flex-col gap-4 p-4 lg:flex-row">
      <section className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <LanguageSelector value={language} onChange={setLanguage} />
          <EditorToolbar
            isRunning={isRunning}
            onRun={() => run(code, language)}
            onClear={() => setCode('')}
          />
        </div>
        <div className="min-h-[320px] flex-1">
          <CodeEditor language={language} value={code} onChange={setCode} />
        </div>
      </section>

      <section className="min-h-[240px] flex-1 lg:max-w-md">
        <OutputPanel />
      </section>
    </div>
  );
}