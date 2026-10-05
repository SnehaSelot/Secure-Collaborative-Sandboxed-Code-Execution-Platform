import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { DEFAULT_LANGUAGE } from '../config/constants';

export type ThemePreference = 'system' | 'light' | 'dark';
export type WordWrapPreference = 'on' | 'off';
export type TabSizePreference = 2 | 4;
export type FontFamilyPreference = 'system' | 'consolas' | 'cascadia' | 'courier';
export type InterfaceDensity = 'comfortable' | 'compact';

export interface PreferenceValues {
  theme: ThemePreference;
  fontSize: number;
  fontFamily: FontFamilyPreference;
  wordWrap: WordWrapPreference;
  tabSize: TabSizePreference;
  minimap: boolean;
  lineNumbers: boolean;
  defaultLanguage: string;
  clearOutputBeforeRun: boolean;
  showCollaboratorCursors: boolean;
  showParticipantNames: boolean;
  collaborationNotifications: boolean;
  reducedMotion: boolean;
  interfaceDensity: InterfaceDensity;
}

export const DEFAULT_PREFERENCES: PreferenceValues = {
  theme: 'system',
  fontSize: 14,
  fontFamily: 'system',
  wordWrap: 'on',
  tabSize: 4,
  minimap: false,
  lineNumbers: true,
  defaultLanguage: DEFAULT_LANGUAGE,
  clearOutputBeforeRun: true,
  showCollaboratorCursors: true,
  showParticipantNames: true,
  collaborationNotifications: true,
  reducedMotion: false,
  interfaceDensity: 'comfortable',
};

interface PreferencesState extends PreferenceValues {
  setTheme: (theme: ThemePreference) => void;
  setFontSize: (fontSize: number) => void;
  setFontFamily: (fontFamily: FontFamilyPreference) => void;
  setWordWrap: (wordWrap: WordWrapPreference) => void;
  setTabSize: (tabSize: TabSizePreference) => void;
  setMinimap: (minimap: boolean) => void;
  setLineNumbers: (lineNumbers: boolean) => void;
  setDefaultLanguage: (defaultLanguage: string) => void;
  setClearOutputBeforeRun: (clearOutputBeforeRun: boolean) => void;
  setShowCollaboratorCursors: (showCollaboratorCursors: boolean) => void;
  setShowParticipantNames: (showParticipantNames: boolean) => void;
  setCollaborationNotifications: (collaborationNotifications: boolean) => void;
  setReducedMotion: (reducedMotion: boolean) => void;
  setInterfaceDensity: (interfaceDensity: InterfaceDensity) => void;
  resetEditorPreferences: () => void;
  resetPreferences: () => void;
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      ...DEFAULT_PREFERENCES,
      setTheme: (theme) => set({ theme }),
      setFontSize: (fontSize) => set({ fontSize }),
      setFontFamily: (fontFamily) => set({ fontFamily }),
      setWordWrap: (wordWrap) => set({ wordWrap }),
      setTabSize: (tabSize) => set({ tabSize }),
      setMinimap: (minimap) => set({ minimap }),
      setLineNumbers: (lineNumbers) => set({ lineNumbers }),
      setDefaultLanguage: (defaultLanguage) => set({ defaultLanguage }),
      setClearOutputBeforeRun: (clearOutputBeforeRun) => set({ clearOutputBeforeRun }),
      setShowCollaboratorCursors: (showCollaboratorCursors) =>
        set({ showCollaboratorCursors }),
      setShowParticipantNames: (showParticipantNames) =>
        set({ showParticipantNames }),
      setCollaborationNotifications: (collaborationNotifications) =>
        set({ collaborationNotifications }),
      setReducedMotion: (reducedMotion) => set({ reducedMotion }),
      setInterfaceDensity: (interfaceDensity) => set({ interfaceDensity }),
      resetEditorPreferences: () =>
        set({
          theme: DEFAULT_PREFERENCES.theme,
          fontSize: DEFAULT_PREFERENCES.fontSize,
          fontFamily: DEFAULT_PREFERENCES.fontFamily,
          wordWrap: DEFAULT_PREFERENCES.wordWrap,
          tabSize: DEFAULT_PREFERENCES.tabSize,
          minimap: DEFAULT_PREFERENCES.minimap,
          lineNumbers: DEFAULT_PREFERENCES.lineNumbers,
        }),
      resetPreferences: () => set(DEFAULT_PREFERENCES),
    }),
    {
      name: 'glasshouse-preferences',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        theme: state.theme,
        fontSize: state.fontSize,
        fontFamily: state.fontFamily,
        wordWrap: state.wordWrap,
        tabSize: state.tabSize,
        minimap: state.minimap,
        lineNumbers: state.lineNumbers,
        defaultLanguage: state.defaultLanguage,
        clearOutputBeforeRun: state.clearOutputBeforeRun,
        showCollaboratorCursors: state.showCollaboratorCursors,
        showParticipantNames: state.showParticipantNames,
        collaborationNotifications: state.collaborationNotifications,
        reducedMotion: state.reducedMotion,
        interfaceDensity: state.interfaceDensity,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<PreferenceValues> | undefined;
        return {
          ...currentState,
          ...persisted,
          tabSize: persisted?.tabSize === 2 ? 2 : 4,
        };
      },
    },
  ),
);
