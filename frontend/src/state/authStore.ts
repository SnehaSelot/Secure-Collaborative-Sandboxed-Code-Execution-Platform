/**
 * state/authStore.ts — Authentication state for collaboration features.
 *
 * F3: Stores the current user's identity (JWT token + display name) obtained
 * from the backend auth endpoints. Provider and presence awareness use this
 * to set local state and authenticate WebSocket connections.
 *
 * This store is intentionally minimal — it only stores what the collab
 * features need. It does NOT replace any existing auth or execution flows.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { apiClient } from '../api/client';

export interface AuthUser {
  /** Backend user UUID */
  id: string;
  /** Display name shown to collaborators */
  displayName: string;
  /** JWT token for WebSocket authentication */
  token: string;
}

interface AuthState {
  user: AuthUser | null;
  isLoading: boolean;
  error: string | null;

  /** Login with email + password — obtains JWT from backend */
  login: (email: string, password: string) => Promise<void>;
  /** Register new account */
  signup: (email: string, displayName: string, password: string) => Promise<void>;
  /** Clear stored credentials */
  logout: () => void;
  /** Manually set user (e.g. for testing or token refresh) */
  setUser: (user: AuthUser | null) => void;
}

interface LoginResponse {
  access_token: string;
  user_id: string;
  display_name: string;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      isLoading: false,
      error: null,

      login: async (email, password) => {
        set({ isLoading: true, error: null });
        try {
          const response = await apiClient.post<LoginResponse>('/auth/login', {
            email: email.trim().toLowerCase(),
            password,
          });
          const { access_token, user_id, display_name } = response.data;
          set({
            user: { id: user_id, displayName: display_name, token: access_token },
            isLoading: false,
            error: null,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Login failed';
          set({ isLoading: false, error: message });
          throw error;
        }
      },

      signup: async (email, displayName, password) => {
        set({ isLoading: true, error: null });
        try {
          await apiClient.post('/auth/signup', {
            email: email.trim().toLowerCase(),
            display_name: displayName,
            password,
          });
          set({ isLoading: false, error: null });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Signup failed';
          set({ isLoading: false, error: message });
          throw error;
        }
      },

      logout: () => {
        set({ user: null, error: null });
      },

      setUser: (user) => {
        set({ user });
      },
    }),
    {
      name: 'glasshouse-auth',
      // Only persist user identity, not loading/error state
      partialize: (state) => ({ user: state.user }),
    },
  ),
);

