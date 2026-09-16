import { useLanguages } from '../../hooks/useLanguages';

interface LanguageSelectorProps {
  value: string;
  onChange: (language: string) => void;
  disabled?: boolean;
}

/**
 * BACKEND INTEGRATION:
 * Endpoint: GET /languages (via useLanguages)
 * Status: Available
 * Falls back to a local list only if the backend request fails —
 * see FALLBACK_LANGUAGES in config/constants.ts.
 */
export function LanguageSelector({ value, onChange, disabled }: LanguageSelectorProps) {
  const { languages, loading, isFallback } = useLanguages();

  // A file's language can be something the backend can't execute at all
  // (e.g. "markdown" for a README.md, detected by the File Explorer).
  // Keep the <select> controlled correctly by making sure `value`
  // always has a matching <option>, even if it's not one of the 7
  // backend-executable languages.
  const options = languages.includes(value) ? languages : [value, ...languages];

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="language-select" className="sr-only">
        Language
      </label>
      <select
        id="language-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={loading || disabled}
        className="rounded-md border border-white/10 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-100 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-500 disabled:opacity-50"
      >
        {options.map((lang) => (
          <option key={lang} value={lang}>
            {lang}
          </option>
        ))}
      </select>
      {isFallback && (
        <span
          className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-400"
          title="Backend unreachable — showing a local fallback list"
        >
          Offline list
        </span>
      )}
    </div>
  );
}