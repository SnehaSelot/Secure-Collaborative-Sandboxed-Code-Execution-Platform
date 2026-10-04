import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type ThemePreference = 'system' | 'light' | 'dark';
export type WordWrapPreference = 'on' | 'off';
export type TabSizePreference = 2 | 4 | 8;

interface PreferencesState {
  theme: ThemePreference;
  fontSize: number;
  wordWrap: WordWrapPreference;
  tabSize: TabSizePreference;
  setTheme: (theme: ThemePreference) => void;
  setFontSize: (fontSize: number) => void;
  setWordWrap: (wordWrap: WordWrapPreference) => void;
  setTabSize: (tabSize: TabSizePreference) => void;
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      theme: 'system',
      fontSize: 14,
      wordWrap: 'on',
      tabSize: 4,
      setTheme: (theme) => set({ theme }),
      setFontSize: (fontSize) => set({ fontSize }),
      setWordWrap: (wordWrap) => set({ wordWrap }),
      setTabSize: (tabSize) => set({ tabSize }),
    }),
    {
      name: 'glasshouse-preferences',
      storage: createJSONStorage(() => localStorage),
      partialize: ({ theme, fontSize, wordWrap, tabSize }) => ({
        theme,
        fontSize,
        wordWrap,
        tabSize,
      }),
    },
  ),
);
