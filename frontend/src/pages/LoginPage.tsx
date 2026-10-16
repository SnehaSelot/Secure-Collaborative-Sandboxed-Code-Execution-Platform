import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle, Eye, EyeOff, LoaderCircle, LockKeyhole } from 'lucide-react';
import axios from 'axios';
import { apiClient, extractErrorMessage } from '../api/client';
import { useAuthStore } from '../state/authStore';

type LoginLocationState = { from?: { pathname?: string }; message?: string };

export function LoginPage({ adminMode = false }: { adminMode?: boolean }) {
  const login = useAuthStore((state) => state.login);
  const logout = useAuthStore((state) => state.logout);
  const setAdminVerified = useAuthStore((state) => state.setAdminVerified);
  const setUser = useAuthStore((state) => state.setUser);
  const user = useAuthStore((state) => state.user);
  const location = useLocation();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rolePreference, setRolePreference] = useState<'user' | 'admin'>(adminMode ? 'admin' : 'user');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const hasResolvedUser = useRef(false);
  const state = location.state as LoginLocationState | null;
  const isAdminFlow = adminMode || rolePreference === 'admin';
  const editorDestination = state?.from || '/editor';

  const resolveUserDestination = useCallback(async (requireAdmin: boolean) => {
    const authenticatedUser = useAuthStore.getState().user;
    if (!authenticatedUser || hasResolvedUser.current) return;
    hasResolvedUser.current = true;
    const headers = { Authorization: `Bearer ${authenticatedUser.token}` };
    try {
      const { data: profile } = await apiClient.get<{ roles: string[] }>('/users/me', { headers });
      const roles = Array.isArray(profile.roles) ? profile.roles : [];
      setUser({ ...authenticatedUser, roles });

      if (!roles.includes('admin')) {
        if (requireAdmin) {
          logout();
          setError('This account does not have administrator access.');
        } else {
          navigate(editorDestination, { replace: true });
        }
        return;
      }

      await apiClient.get('/admin/access', { headers });
      setAdminVerified(true);
      navigate('/admin', { replace: true });
    } catch (requestError) {
      const status = axios.isAxiosError(requestError) ? requestError.response?.status : undefined;
      if (requireAdmin && status === 403) {
        logout();
        setError('This account does not have administrator access.');
      } else if (status === 401) {
        logout();
        setError('Your session could not be verified. Please sign in again.');
      } else if (!requireAdmin) {
        navigate(editorDestination, { replace: true });
      } else {
        setError('Administrator access could not be verified. Please try again later.');
      }
      hasResolvedUser.current = false;
    }
  }, [editorDestination, logout, navigate, setAdminVerified, setUser]);

  useEffect(() => {
    if (!user || adminMode || loading) return;
    const timer = window.setTimeout(() => { void resolveUserDestination(false); }, 0);
    return () => window.clearTimeout(timer);
  }, [user, adminMode, loading, resolveUserDestination]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      await resolveUserDestination(isAdminFlow);
    } catch (requestError) {
      setError(extractErrorMessage(requestError));
      hasResolvedUser.current = false;
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-[calc(100vh-145px)] w-full max-w-6xl items-center justify-center px-5 py-12 sm:px-8">
      <section className="grid w-full max-w-4xl overflow-hidden rounded-2xl border border-white/10 bg-[#071117] shadow-2xl md:grid-cols-[0.9fr_1.1fr]">
        <div className="hidden flex-col justify-between border-r border-white/[0.07] bg-emerald-400/[0.035] p-9 md:flex">
          <LockKeyhole className="text-emerald-300" size={28} />
          <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300">GlassHouse</p><h1 className="mt-3 text-3xl font-semibold leading-tight">A focused workspace for safer coding.</h1><p className="mt-3 text-sm leading-6 text-neutral-400">Sign in to continue to your editor and collaborative rooms.</p></div>
          <p className="text-xs text-neutral-600">Your session is secured by GlassHouse authentication.</p>
        </div>
        <div className="p-6 sm:p-9">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300">{isAdminFlow ? 'Administrator access' : 'Welcome back'}</p>
          <h2 className="mt-2 text-2xl font-semibold">{isAdminFlow ? 'Admin Access' : 'Welcome back'}</h2>
          <p className="mt-2 text-sm text-neutral-500">{isAdminFlow ? 'Restricted administrative console' : state?.message || 'Sign in to your secure development environment.'}</p>
          {isAdminFlow && <p className="mt-3 text-xs font-medium text-amber-200">Authorized personnel only</p>}
          <form className="mt-7 space-y-5" onSubmit={submit}>
            {!adminMode && <fieldset className="flex gap-2"><legend className="mb-2 text-sm text-neutral-300">Sign in as</legend>{([['user', 'User / Developer'], ['admin', 'Admin']] as const).map(([value, label]) => <label key={value} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs ${rolePreference === value ? 'border-emerald-400/40 bg-emerald-400/[0.07] text-neutral-100' : 'border-white/10 text-neutral-400'}`}><input type="radio" name="rolePreference" value={value} checked={rolePreference === value} onChange={() => setRolePreference(value)} className="accent-emerald-400" />{label}</label>)}</fieldset>}
            <label className="block text-sm text-neutral-300">Email address<input autoComplete="email" type="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} className="mt-2 w-full rounded-lg border border-white/10 bg-black/20 px-3.5 py-3 text-sm text-neutral-100 outline-none transition placeholder:text-neutral-600 focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-400/10" placeholder="you@example.com" /></label>
            <label className="block text-sm text-neutral-300">Password<span className="mt-2 flex rounded-lg border border-white/10 bg-black/20 focus-within:border-emerald-400/60 focus-within:ring-2 focus-within:ring-emerald-400/10"><input autoComplete="current-password" type={showPassword ? 'text' : 'password'} required value={password} onChange={(e) => setPassword(e.target.value)} className="min-w-0 flex-1 bg-transparent px-3.5 py-3 text-sm text-neutral-100 outline-none placeholder:text-neutral-600" placeholder="Enter your password" /><button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword((visible) => !visible)} className="px-3 text-neutral-500 hover:text-neutral-200">{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></span></label>
            {error && <p role="alert" className="flex items-start gap-2 rounded-lg border border-rose-400/20 bg-rose-400/[0.06] p-3 text-sm text-rose-200"><AlertCircle size={17} className="mt-0.5 shrink-0" />{error}</p>}
            <button disabled={loading} className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-400 px-4 py-3 text-sm font-semibold text-[#03120f] transition hover:bg-emerald-300 disabled:cursor-wait disabled:opacity-60">{loading && <LoaderCircle size={16} className="animate-spin" />}{loading ? 'Signing in…' : 'Sign in'}</button>
          </form>
          {!adminMode && <p className="mt-6 text-center text-sm text-neutral-500">New to GlassHouse? <Link to="/register" className="font-medium text-emerald-300 hover:text-emerald-200">Create an account</Link></p>}
        </div>
      </section>
    </main>
  );
}
