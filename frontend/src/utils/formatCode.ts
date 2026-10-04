/**
 * Languages this project can format entirely client-side, no backend
 * call needed. Prettier's standalone bundle only ships JS/TS/CSS/HTML/
 * Markdown/JSON parsers — of GlassHouse's 7 execution languages
 * (config/constants.ts's FALLBACK_LANGUAGES), only 'javascript' overlaps.
 */
export const FORMATTABLE_LANGUAGES = ['javascript'] as const;
export type FormattableLanguage = (typeof FORMATTABLE_LANGUAGES)[number];

export function isFormattable(language: string): language is FormattableLanguage {
  return (FORMATTABLE_LANGUAGES as readonly string[]).includes(language);
}

/**
 * BACKEND INTEGRATION (future):
 * c / cpp / go / java / python / rust each need their own formatter
 * (clang-format, gofmt, google-java-format, black, rustfmt) — these are
 * native CLI tools with no browser-safe equivalent, so they can't be
 * added here the way Prettier was. Formatting those languages requires
 * a backend endpoint, e.g. POST /format { language, code } -> { code },
 * that shells out to the right formatter inside the sandbox image
 * (see backend/app/services/executor.py for where that would live).
 * When that endpoint exists:
 *   1. Add the language to a second list here (or just extend this
 *      function) that calls the new endpoint instead of throwing.
 *   2. EditorToolbar.tsx / EditorPage.tsx don't need to change — they
 *      already call this same formatCode() and just show whatever
 *      it resolves/rejects with.
 */
export async function formatCode(code: string, language: string): Promise<string> {
  if (!isFormattable(language)) {
    throw new Error(`Formatting isn't available for ${language} yet.`);
  }

  // Dynamically imported so Prettier (~900KB) only loads the first time
  // someone actually clicks Format, instead of bloating every page load.
  const [prettier, babelPlugin, estreePlugin] = await Promise.all([
    import('prettier/standalone'),
    import('prettier/plugins/babel'),
    import('prettier/plugins/estree'),
  ]);

  return prettier.format(code, {
    parser: 'babel',
    plugins: [babelPlugin.default, estreePlugin.default],
    semi: true,
    singleQuote: true,
  });
}