import { usePreferencesStore } from '../state/preferencesStore';

const fieldClassName =
  'w-full rounded-md border border-white/10 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-emerald-500/50';

export function SettingsPage() {
  const theme = usePreferencesStore((state) => state.theme);
  const fontSize = usePreferencesStore((state) => state.fontSize);
  const wordWrap = usePreferencesStore((state) => state.wordWrap);
  const tabSize = usePreferencesStore((state) => state.tabSize);
  const setTheme = usePreferencesStore((state) => state.setTheme);
  const setFontSize = usePreferencesStore((state) => state.setFontSize);
  const setWordWrap = usePreferencesStore((state) => state.setWordWrap);
  const setTabSize = usePreferencesStore((state) => state.setTabSize);

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-xl font-semibold text-neutral-100">Settings</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Preferences apply immediately and are saved in this browser.
        </p>
      </header>

      <section className="rounded-lg border border-white/10 bg-neutral-900/60 p-5">
        <h2 className="text-sm font-semibold text-neutral-200">Appearance</h2>
        <div className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_16rem] sm:items-center">
          <label htmlFor="theme-preference" className="text-sm text-neutral-300">
            Theme
          </label>
          <select
            id="theme-preference"
            className={fieldClassName}
            value={theme}
            onChange={(event) => setTheme(event.target.value as typeof theme)}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
      </section>

      <section className="rounded-lg border border-white/10 bg-neutral-900/60 p-5">
        <h2 className="text-sm font-semibold text-neutral-200">Editor</h2>
        <div className="mt-4 grid gap-4">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_16rem] sm:items-center">
            <label htmlFor="editor-font-size" className="text-sm text-neutral-300">
              Font size <span className="text-neutral-500">({fontSize}px)</span>
            </label>
            <input
              id="editor-font-size"
              type="range"
              min={12}
              max={24}
              step={1}
              value={fontSize}
              onChange={(event) => setFontSize(Number(event.target.value))}
              className="w-full accent-emerald-500"
            />
          </div>

          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_16rem] sm:items-center">
            <label htmlFor="editor-word-wrap" className="text-sm text-neutral-300">
              Word wrap
            </label>
            <select
              id="editor-word-wrap"
              className={fieldClassName}
              value={wordWrap}
              onChange={(event) => setWordWrap(event.target.value as typeof wordWrap)}
            >
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </div>

          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_16rem] sm:items-center">
            <label htmlFor="editor-tab-size" className="text-sm text-neutral-300">
              Tab size
            </label>
            <select
              id="editor-tab-size"
              className={fieldClassName}
              value={tabSize}
              onChange={(event) => setTabSize(Number(event.target.value) as typeof tabSize)}
            >
              <option value={2}>2 spaces</option>
              <option value={4}>4 spaces</option>
              <option value={8}>8 spaces</option>
            </select>
          </div>
        </div>
      </section>

      <p role="status" className="text-xs text-neutral-500">
        Preferences saved locally.
      </p>
    </section>
  );
}
