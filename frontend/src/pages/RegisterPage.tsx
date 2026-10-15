import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle, LoaderCircle } from 'lucide-react';
import { useAuthStore } from '../state/authStore';
import { extractErrorMessage } from '../api/client';

export function RegisterPage() {
  const signup = useAuthStore((state) => state.signup);
  const login = useAuthStore((state) => state.login);
  const location = useLocation();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    if (password !== confirmation) { setError('Passwords do not match.'); return; }
    if (new TextEncoder().encode(password).length > 72) { setError('Password must be 72 bytes or fewer.'); return; }
    setLoading(true);
    try {
      await signup(email, name.trim(), password);
      await login(email, password);
      const state = location.state as { from?: { pathname?: string; search?: string; hash?: string } } | null;
      navigate(state?.from || '/editor', { replace: true });
    } catch (requestError) {
      setError(extractErrorMessage(requestError));
    } finally { setLoading(false); }
  };

  return (
    <main className="mx-auto flex min-h-[calc(100vh-145px)] w-full max-w-6xl items-center justify-center px-5 py-12 sm:px-8">
      <section className="w-full max-w-xl rounded-2xl border border-white/10 bg-[#071117] p-6 shadow-2xl sm:p-9">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300">Get started</p>
        <h1 className="mt-2 text-2xl font-semibold">Create your GlassHouse account</h1>
        <p className="mt-2 text-sm text-neutral-500">Create a member account to open your secure workspace.</p>
        <form className="mt-7 space-y-4" onSubmit={submit}>
          <label className="block text-sm text-neutral-300">Display name<input autoComplete="name" required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} className="mt-2 w-full rounded-lg border border-white/10 bg-black/20 px-3.5 py-3 text-sm outline-none focus:border-emerald-400/60" /></label>
          <label className="block text-sm text-neutral-300">Email address<input autoComplete="email" type="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} className="mt-2 w-full rounded-lg border border-white/10 bg-black/20 px-3.5 py-3 text-sm outline-none focus:border-emerald-400/60" /></label>
          <label className="block text-sm text-neutral-300">Password<input autoComplete="new-password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} className="mt-2 w-full rounded-lg border border-white/10 bg-black/20 px-3.5 py-3 text-sm outline-none focus:border-emerald-400/60" /><span className="mt-1 block text-xs text-neutral-600">At least 8 characters, at most 72 UTF-8 bytes.</span></label>
          <label className="block text-sm text-neutral-300">Confirm password<input autoComplete="new-password" type="password" required minLength={8} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} className="mt-2 w-full rounded-lg border border-white/10 bg-black/20 px-3.5 py-3 text-sm outline-none focus:border-emerald-400/60" /></label>
          {error && <p role="alert" className="flex gap-2 rounded-lg border border-rose-400/20 bg-rose-400/[0.06] p-3 text-sm text-rose-200"><AlertCircle size={17} className="shrink-0" />{error}</p>}
          <button disabled={loading} className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-400 px-4 py-3 text-sm font-semibold text-[#03120f] hover:bg-emerald-300 disabled:opacity-60">{loading && <LoaderCircle size={16} className="animate-spin" />}{loading ? 'Creating account…' : 'Create account'}</button>
        </form>
        <p className="mt-6 text-center text-sm text-neutral-500">Already registered? <Link to="/login" className="font-medium text-emerald-300 hover:text-emerald-200">Sign in</Link></p>
      </section>
    </main>
  );
}
