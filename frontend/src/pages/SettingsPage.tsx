import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { DEFAULT_LANGUAGE } from '../config/constants';
import { useLanguages } from '../hooks/useLanguages';
import { useLimits } from '../hooks/useLimits';
import { usePreferencesStore } from '../state/preferencesStore';

const fieldClassName =
  'w-full rounded-md border border-white/10 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-emerald-500/50 disabled:cursor-not-allowed disabled:opacity-50';
const rowClassName =
  'grid gap-2 sm:grid-cols-[minmax(0,1fr)_16rem] sm:items-center';

function ToggleRow({
  id,
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className={rowClassName}>
      <div>
        <label htmlFor={id} className="text-sm text-neutral-300">
          {label}
        </label>
        {description && <p className="mt-0.5 text-xs text-neutral-500">{description}</p>}
      </div>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 accent-emerald-500 disabled:cursor-not-allowed"
      />
    </div>
  );
}

function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-white/10 bg-neutral-900/60 p-5">
      <h2 className="text-sm font-semibold text-neutral-200">{title}</h2>
      <div className="mt-4 grid gap-4">{children}</div>
    </section>
  );
}

export function SettingsPage() {
  const {
    theme,
    fontSize,
    fontFamily,
    wordWrap,
    tabSize,
    minimap,
    lineNumbers,
    defaultLanguage,
    clearOutputBeforeRun,
    showCollaboratorCursors,
    showParticipantNames,
    collaborationNotifications,
    reducedMotion,
    interfaceDensity,
    setTheme,
    setFontSize,
    setFontFamily,
    setWordWrap,
    setTabSize,
    setMinimap,
    setLineNumbers,
    setDefaultLanguage,
    setClearOutputBeforeRun,
    setShowCollaboratorCursors,
    setShowParticipantNames,
    setCollaborationNotifications,
    setReducedMotion,
    setInterfaceDensity,
    resetEditorPreferences,
    resetPreferences,
  } = usePreferencesStore();
  const { languages, loading: languagesLoading, isFallback } = useLanguages();
  const { limits, loading: limitsLoading, error: limitsError } = useLimits();
  const [saveMessage, setSaveMessage] = useState('Changes are saved locally in this browser.');

  useEffect(() => {
    if (languagesLoading || languages.length === 0 || languages.includes(defaultLanguage)) {
      return;
    }

    setDefaultLanguage(
      languages.includes(DEFAULT_LANGUAGE) ? DEFAULT_LANGUAGE : languages[0] ?? DEFAULT_LANGUAGE,
    );
  }, [defaultLanguage, languages, languagesLoading, setDefaultLanguage]);

  function announceSaved() {
    setSaveMessage('Preference saved in this browser.');
  }

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-xl font-semibold text-neutral-100">Settings</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Preferences apply immediately and are saved in this browser. They do not change
          server-side sandbox limits.
        </p>
      </header>

      <SettingsSection title="Editor">
        <div className={rowClassName}>
          <label htmlFor="theme-preference" className="text-sm text-neutral-300">
            Application and editor theme
          </label>
          <select
            id="theme-preference"
            className={fieldClassName}
            value={theme}
            onChange={(event) => {
              setTheme(event.target.value as typeof theme);
              announceSaved();
            }}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>

        <div className={rowClassName}>
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
            onChange={(event) => {
              setFontSize(Number(event.target.value));
              announceSaved();
            }}
            className="w-full accent-emerald-500"
          />
        </div>

        <div className={rowClassName}>
          <label htmlFor="editor-font-family" className="text-sm text-neutral-300">
            Font family
          </label>
          <select
            id="editor-font-family"
            className={fieldClassName}
            value={fontFamily}
            onChange={(event) => {
              setFontFamily(event.target.value as typeof fontFamily);
              announceSaved();
            }}
          >
            <option value="system">System monospace</option>
            <option value="consolas">Consolas</option>
            <option value="cascadia">Cascadia Code</option>
            <option value="courier">Courier New</option>
          </select>
        </div>

        <div className={rowClassName}>
          <label htmlFor="editor-tab-size" className="text-sm text-neutral-300">
            Tab size
          </label>
          <select
            id="editor-tab-size"
            className={fieldClassName}
            value={tabSize}
            onChange={(event) => {
              setTabSize(Number(event.target.value) as typeof tabSize);
              announceSaved();
            }}
          >
            <option value={2}>2 spaces</option>
            <option value={4}>4 spaces</option>
          </select>
        </div>

        <ToggleRow
          id="editor-word-wrap"
          label="Word wrap"
          checked={wordWrap === 'on'}
          onChange={(value) => {
            setWordWrap(value ? 'on' : 'off');
            announceSaved();
          }}
        />
        <ToggleRow
          id="editor-minimap"
          label="Minimap"
          checked={minimap}
          onChange={(value) => {
            setMinimap(value);
            announceSaved();
          }}
        />
        <ToggleRow
          id="editor-line-numbers"
          label="Line numbers"
          checked={lineNumbers}
          onChange={(value) => {
            setLineNumbers(value);
            announceSaved();
          }}
        />

        <div className="flex justify-end border-t border-white/10 pt-3">
          <button
            type="button"
            onClick={() => {
              resetEditorPreferences();
              setSaveMessage('Editor settings restored to defaults.');
            }}
            className="rounded-md border border-white/10 px-3 py-2 text-xs text-neutral-300 transition hover:bg-white/5"
          >
            Restore editor defaults
          </button>
        </div>
      </SettingsSection>

      <SettingsSection title="Execution">
        <div className={rowClassName}>
          <div>
            <label htmlFor="default-language" className="text-sm text-neutral-300">
              Default language for new files
            </label>
            <p className="mt-0.5 text-xs text-neutral-500">
              Used only when a new filename has no recognized language extension. An
              active file always runs using its own selected language.
            </p>
          </div>
          <select
            id="default-language"
            className={fieldClassName}
            value={defaultLanguage}
            disabled={languagesLoading}
            onChange={(event) => {
              setDefaultLanguage(event.target.value);
              announceSaved();
            }}
          >
            {!languages.includes(defaultLanguage) && (
              <option value={defaultLanguage}>{defaultLanguage} (saved preference)</option>
            )}
            {languages.map((language) => (
              <option key={language} value={language}>
                {language}
              </option>
            ))}
          </select>
        </div>
        {isFallback && (
          <p className="text-xs text-amber-400">
            The backend language list is unavailable; showing the supported fallback
            list.
          </p>
        )}

        <ToggleRow
          id="clear-output"
          label="Clear output before each run"
          description="When off, previous terminal lines remain and new output is appended."
          checked={clearOutputBeforeRun}
          onChange={(value) => {
            setClearOutputBeforeRun(value);
            announceSaved();
          }}
        />

        <div className={rowClassName}>
          <div>
            <p className="text-sm text-neutral-300">Execution timeout</p>
            <p className="mt-0.5 text-xs text-neutral-500">
              Read-only backend sandbox limit. Frontend preferences cannot change it.
            </p>
          </div>
          <p className="text-sm text-neutral-400" role="status">
            {limits && Object.keys(limits.timeout_seconds).length > 0
              ? Object.entries(limits.timeout_seconds)
                  .map(([language, seconds]) => `${language}: ${seconds}s`)
                  .join(' · ')
              : limitsLoading
                ? 'Loading backend limit…'
                : limitsError ?? 'Unavailable'}
          </p>
        </div>

        <div className={rowClassName}>
          <div>
            <p className="text-sm text-neutral-300">Local auto-save</p>
            <p className="mt-0.5 text-xs text-neutral-500">
              Workspace and Yjs documents are persisted in this browser. There is no
              server save. Auto-save cannot be disabled independently of document
              persistence.
            </p>
          </div>
          <span className="text-sm text-neutral-400">Always on</span>
        </div>
      </SettingsSection>

      <SettingsSection title="Collaboration">
        <p className="text-xs text-neutral-500">
          Collaboration currently runs local-only and has no network Awareness instance.
          These options will become available when a real collaboration provider exists.
        </p>
        <ToggleRow
          id="collaborator-cursors"
          label="Show collaborator cursors"
          checked={showCollaboratorCursors}
          disabled
          onChange={setShowCollaboratorCursors}
        />
        <ToggleRow
          id="participant-names"
          label="Show participant names"
          checked={showParticipantNames}
          disabled
          onChange={setShowParticipantNames}
        />
        <ToggleRow
          id="collaboration-notifications"
          label="Collaboration notifications"
          checked={collaborationNotifications}
          disabled
          onChange={setCollaborationNotifications}
        />
        <p className="text-xs text-neutral-500">
          Presence and connection status reflect the provider only; no connected users
          are simulated.
        </p>
      </SettingsSection>

      <SettingsSection title="Accessibility">
        <ToggleRow
          id="reduced-motion"
          label="Reduce motion"
          description="Reduces interface animation and transition duration."
          checked={reducedMotion}
          onChange={(value) => {
            setReducedMotion(value);
            announceSaved();
          }}
        />
        <div className={rowClassName}>
          <div>
            <label htmlFor="interface-density" className="text-sm text-neutral-300">
              Interface density
            </label>
            <p className="mt-0.5 text-xs text-neutral-500">
              Compact reduces common panel padding and spacing across the app.
            </p>
          </div>
          <select
            id="interface-density"
            className={fieldClassName}
            value={interfaceDensity}
            onChange={(event) => {
              setInterfaceDensity(event.target.value as typeof interfaceDensity);
              announceSaved();
            }}
          >
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
          </select>
        </div>

        <div>
          <h3 className="text-sm text-neutral-300">Editor shortcuts</h3>
          <p className="mt-0.5 text-xs text-neutral-500">
            Standard Monaco Editor shortcuts (Windows/Linux).
          </p>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="font-mono text-neutral-300">Ctrl+F</dt>
            <dd className="text-neutral-500">Find</dd>
            <dt className="font-mono text-neutral-300">Ctrl+H</dt>
            <dd className="text-neutral-500">Replace</dd>
            <dt className="font-mono text-neutral-300">Ctrl+/</dt>
            <dd className="text-neutral-500">Toggle line comment</dd>
          </dl>
        </div>
      </SettingsSection>

      <SettingsSection title="Data Management">
        <p className="text-xs text-neutral-500">
          Preferences are stored separately from workspace files and Yjs IndexedDB data.
          Clearing workspace data is unavailable here because open Yjs documents and
          saved sessions do not yet have a coordinated close-and-clear lifecycle.
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              resetPreferences();
              setSaveMessage('All preferences restored to defaults.');
            }}
            className="rounded-md border border-white/10 px-3 py-2 text-xs text-neutral-300 transition hover:bg-white/5"
          >
            Reset all preferences
          </button>
          <button
            type="button"
            disabled
            title="Safe clearing is not supported while persisted documents and sessions may be open."
            className="rounded-md border border-red-500/20 px-3 py-2 text-xs text-red-300 opacity-50"
          >
            Clear saved workspace data
          </button>
        </div>
      </SettingsSection>

      <p role="status" aria-live="polite" className="text-xs text-neutral-500">
        {saveMessage}
      </p>
    </section>
  );
}
