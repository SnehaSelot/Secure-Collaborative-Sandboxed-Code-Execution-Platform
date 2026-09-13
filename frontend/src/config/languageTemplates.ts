/**
 * Welcome/default code shown the first time a user selects a language
 * that has no code yet in the current session.
 *
 * Keyed by the EXACT language identifiers GET /languages returns
 * (confirmed against executor.py's LANGUAGE_IMAGES keys — not guessed).
 *
 * IMPORTANT: kept in sync with FALLBACK_LANGUAGES in config/constants.ts.
 * If the backend ever adds an 8th language, add its template here too —
 * until then, getLanguageTemplate() below falls back to a generic
 * comment instead of crashing.
 */
export const LANGUAGE_TEMPLATES: Record<string, string> = {
  python: 'print("Welcome to GlassHouse!")\n',

  javascript: 'console.log("Welcome to GlassHouse!");\n',

  java:
    'public class Main {\n' +
    '    public static void main(String[] args) {\n' +
    '        System.out.println("Welcome to GlassHouse!");\n' +
    '    }\n' +
    '}\n',

  c:
    '#include <stdio.h>\n\n' +
    'int main() {\n' +
    '    printf("Welcome to GlassHouse!\\n");\n' +
    '    return 0;\n' +
    '}\n',

  cpp:
    '#include <iostream>\n' +
    'using namespace std;\n\n' +
    'int main() {\n' +
    '    cout << "Welcome to GlassHouse!" << endl;\n' +
    '    return 0;\n' +
    '}\n',

  go:
    'package main\n\n' +
    'import "fmt"\n\n' +
    'func main() {\n' +
    '    fmt.Println("Welcome to GlassHouse!")\n' +
    '}\n',

  rust: 'fn main() {\n    println!("Welcome to GlassHouse!");\n}\n',
};

/**
 * Never throws, never returns undefined — a language missing from the
 * map above (e.g. the backend added one before this file was updated)
 * gets a generic placeholder instead of breaking the editor.
 */
export function getLanguageTemplate(language: string): string {
  return LANGUAGE_TEMPLATES[language] ?? `// Welcome to GlassHouse! Start writing ${language} here.\n`;
}

/**
 * File-extension → Monaco/backend language identifier, used by the File
 * Explorer's "New File" flow to detect a language from a filename.
 *
 * NOTE: this list is intentionally broader than the 7 backend-executable
 * languages — e.g. "md" maps to "markdown" for Monaco syntax highlighting
 * even though POST /execute can't run it. Trying to Run such a file will
 * surface the backend's real 400 "Unsupported language" error rather
 * than pretending it works — see BACKEND_API.md.
 */
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  py: 'python',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  go: 'go',
  rs: 'rust',
  md: 'markdown',
  json: 'json',
  txt: 'plaintext',
};

/**
 * Returns undefined (never guesses) when the extension is unrecognized
 * or the filename has no extension — callers should fall back to
 * 'plaintext' themselves so the intent ("we don't know") stays visible.
 */
export function detectLanguageFromFilename(filename: string): string | undefined {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1 || lastDot === filename.length - 1) {
    return undefined;
  }
  const ext = filename.slice(lastDot + 1).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext];
}