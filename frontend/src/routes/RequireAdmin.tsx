import { useEffect, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import axios from 'axios';
import { apiClient } from '../api/client';
import { useAuthStore } from '../state/authStore';

type GuardResult = { token: string; state: 'allowed' | 'denied' | 'error'; message?: string };

export function RequireAdmin({ children }: { children: ReactNode }) {
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const [result, setResult] = useState<GuardResult | null>(null);

  useEffect(() => {
    if (!user) return;
    let active = true;
    apiClient.get('/admin/access', { headers: { Authorization: `Bearer ${user.token}` } })
      .then(() => {
        if (active) {
          useAuthStore.getState().setAdminVerified(true);
          setResult({ token: user.token, state: 'allowed' });
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (axios.isAxiosError(error) && error.response?.status === 401) {
          logout();
          setResult({ token: user.token, state: 'denied' });
          return;
        }
        if (axios.isAxiosError(error) && error.response?.status === 403) {
          setResult({ token: user.token, state: 'denied' });
          return;
        }
        setResult({ token: user.token, state: 'error', message: 'Administrator access could not be verified. Try again when the service is available.' });
      });
    return () => { active = false; };
  }, [user, logout]);

  if (!user) return <Navigate to="/login" replace />;
  const guardState = result?.token === user.token ? result.state : 'checking';
  if (guardState === 'denied') return <Navigate to="/editor" replace state={{ message: 'Administrator access is required.' }} />;
  if (guardState === 'error') return <p role="alert" className="m-6 rounded-lg border border-rose-400/20 bg-rose-400/[0.06] p-4 text-sm text-rose-200">{result?.message}</p>;
  if (guardState !== 'allowed') return <p role="status" className="m-6 text-sm text-neutral-400">Verifying administrator access…</p>;
  return <>{children}</>;
}
