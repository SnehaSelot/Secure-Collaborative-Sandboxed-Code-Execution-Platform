import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { apiClient } from '../api/client';
import { useAuthStore } from '../state/authStore';

interface CollaborationStats { rooms: number; clients: number }

export function AdminPage() {
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const setAdminVerified = useAuthStore((state) => state.setAdminVerified);
  const navigate = useNavigate();
  const [stats, setStats] = useState<CollaborationStats | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    if (!user) return;
    apiClient.get<CollaborationStats>('/collab/stats', { headers: { Authorization: `Bearer ${user.token}` } })
      .then(({ data }) => { if (active) { setStats(data); setAdminVerified(true); } })
      .catch((requestError: unknown) => {
        if (!active) return;
        setAdminVerified(false);
        if (axios.isAxiosError(requestError) && requestError.response?.status === 401) {
          logout();
          navigate('/login', { replace: true, state: { message: 'Your session expired. Please sign in again.' } });
        } else if (axios.isAxiosError(requestError) && requestError.response?.status === 403) {
          setError('Your account does not have administrator access.');
          navigate('/editor', { replace: true, state: { message: 'Administrator access is required.' } });
        } else {
          setError('Administrator access could not be verified.');
        }
      });
    return () => { active = false; };
  }, [user, logout, navigate, setAdminVerified]);

  if (!user) return <Navigate to="/admin/login" replace />;
  return <section className="mx-auto w-full max-w-5xl space-y-6 p-6 sm:p-8">
    <header><p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300">GlassHouse</p><h1 className="mt-2 text-2xl font-semibold">Admin dashboard</h1><p className="mt-1 text-sm text-neutral-500">Collaboration service overview.</p></header>
    {error ? <div role="alert" className="rounded-lg border border-rose-400/20 bg-rose-400/[0.06] p-4 text-sm text-rose-200">{error}</div> : stats ? <div className="grid gap-4 sm:grid-cols-2"><article className="rounded-xl border border-white/10 bg-neutral-900/60 p-5"><p className="text-sm text-neutral-500">Active rooms</p><p className="mt-2 text-3xl font-semibold text-neutral-100">{stats.rooms}</p></article><article className="rounded-xl border border-white/10 bg-neutral-900/60 p-5"><p className="text-sm text-neutral-500">Connected clients</p><p className="mt-2 text-3xl font-semibold text-neutral-100">{stats.clients}</p></article></div> : <p role="status" className="text-sm text-neutral-400">Verifying administrator access…</p>}
  </section>;
}
