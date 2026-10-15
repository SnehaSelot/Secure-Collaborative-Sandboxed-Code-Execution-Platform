import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { extractErrorMessage } from '../api/client';
import { fetchMyProfilePhoto, getMyProfile, updateMyProfile, uploadMyProfilePhoto, type UserProfile } from '../api/profile';
import { useAuthStore } from '../state/authStore';
import { usePreferencesStore } from '../state/preferencesStore';

function getInitials(name: string | undefined) {
  return name?.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'GH';
}

export function ProfilePage() {
  const user = useAuthStore((state) => state.user);
  const adminVerified = useAuthStore((state) => state.adminVerified);
  const logout = useAuthStore((state) => state.logout);
  const updateProfile = useAuthStore((state) => state.updateProfile);
  const navigate = useNavigate();
  const theme = usePreferencesStore((state) => state.theme);
  const fontSize = usePreferencesStore((state) => state.fontSize);
  const wordWrap = usePreferencesStore((state) => state.wordWrap);
  const defaultLanguage = usePreferencesStore((state) => state.defaultLanguage);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [name, setName] = useState(user?.displayName ?? '');
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<string | null>(null);

  useEffect(() => {
    if (!user?.token) return;
    let active = true;
    void getMyProfile(user.token).then((data) => {
      if (!active) return;
      setProfile(data); setName(data.display_name);
      updateProfile({ id: data.user_id, displayName: data.display_name, email: data.email, roles: data.roles, createdAt: data.created_at, photoUrl: data.profile_photo_url });
    }).catch((reason: unknown) => active && setError(extractErrorMessage(reason)));
    return () => { active = false; };
  }, [user?.id, user?.token, updateProfile]);

  useEffect(() => {
    if (!user?.token || !profile?.profile_photo_url) return;
    let active = true; let url: string | null = null;
    void fetchMyProfilePhoto(user.token, profile.profile_photo_url).then((blob) => { if (active) { url = URL.createObjectURL(blob); setPhotoUrl(url); } }).catch(() => undefined);
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [user?.token, profile?.profile_photo_url]);

  useEffect(() => () => { if (previewRef.current) URL.revokeObjectURL(previewRef.current); }, []);

  const saveName = async () => {
    if (!user?.token || !name.trim() || name.trim().length > 64) { setError('Name must contain 1 to 64 characters.'); return; }
    setBusy(true); setError(null); setMessage(null);
    try {
      const data = await updateMyProfile(user.token, name.trim());
      setProfile(data); setName(data.display_name);
      updateProfile({ id: data.user_id, displayName: data.display_name, email: data.email, roles: data.roles, createdAt: data.created_at, photoUrl: data.profile_photo_url });
      setMessage('Profile name saved.');
    } catch (reason) { setError(extractErrorMessage(reason)); } finally { setBusy(false); }
  };

  const uploadPhoto = async () => {
    if (!user?.token || !photo) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const data = await uploadMyProfilePhoto(user.token, photo);
      setProfile(data); setPhoto(null); setPhotoPreview(null);
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      previewRef.current = null;
      updateProfile({ id: data.user_id, displayName: data.display_name, email: data.email, roles: data.roles, createdAt: data.created_at, photoUrl: data.profile_photo_url });
      setMessage('Profile photo uploaded.');
    } catch (reason) {
      setError(extractErrorMessage(reason)); setPhoto(null); setPhotoPreview(null);
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      previewRef.current = null;
    } finally { setBusy(false); }
  };

  const roles = profile?.roles ?? user?.roles ?? [];
  const role = roles.includes('admin') ? 'Admin' : roles.join(', ') || (adminVerified ? 'Admin' : 'Unavailable');

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-6 overflow-auto p-5 sm:p-8">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300">Account</p>
        <h1 className="mt-2 text-2xl font-semibold text-neutral-100">My Profile</h1>
        <p className="mt-1 text-sm text-neutral-500">Identity and account controls for your GlassHouse workspace.</p>
      </header>
      {error && <p role="alert" className="rounded-lg border border-rose-400/20 bg-rose-400/[0.06] px-4 py-3 text-sm text-rose-200">{error}</p>}
      {message && <p role="status" className="rounded-lg border border-emerald-400/20 bg-emerald-400/[0.06] px-4 py-3 text-sm text-emerald-200">{message}</p>}

      <section className="rounded-xl border border-white/10 bg-neutral-900/60 p-5 sm:p-6" aria-labelledby="profile-overview-title">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            {photoPreview || photoUrl ? <img alt="Profile" src={photoPreview ?? photoUrl ?? undefined} className="h-14 w-14 shrink-0 rounded-2xl border border-emerald-300/25 object-cover" /> : <span aria-label={`${user?.displayName || 'GlassHouse user'} avatar initials`} className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-emerald-300/25 bg-emerald-400/10 text-lg font-semibold text-emerald-200">{getInitials(user?.displayName)}</span>}
            <div className="min-w-0 flex-1"><h2 id="profile-overview-title" className="truncate text-lg font-semibold text-neutral-100">{profile?.display_name || user?.displayName || 'GlassHouse user'}</h2>{user?.email && <p className="mt-1 truncate text-sm text-neutral-400">{user.email}</p>}<span className="mt-2 inline-flex rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs text-neutral-400">{role}</span></div>
          </div>
          <div className="flex flex-wrap gap-2"><input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) { setError('Choose a PNG, JPEG, or WebP image under 5 MB.'); return; } if (previewRef.current) URL.revokeObjectURL(previewRef.current); previewRef.current = URL.createObjectURL(file); setPhotoPreview(previewRef.current); setPhoto(file); setError(null); }} /><button type="button" onClick={() => inputRef.current?.click()} className="rounded-lg border border-white/10 px-3.5 py-2 text-sm text-neutral-200">Choose photo</button><button type="button" disabled={!photo || busy} onClick={() => void uploadPhoto()} className="rounded-lg bg-emerald-500 px-3.5 py-2 text-sm font-medium text-neutral-950 disabled:opacity-50">{busy && photo ? 'Uploading…' : 'Upload photo'}</button></div>
        </div>
        <div className="mt-5 flex flex-wrap items-end gap-3"><label className="min-w-[220px] flex-1 text-xs text-neutral-500" htmlFor="profile-display-name">Display name<input id="profile-display-name" value={name} maxLength={64} onChange={(event) => setName(event.target.value)} className="mt-1.5 w-full rounded-lg border border-white/10 bg-neutral-950 px-3 py-2.5 text-sm text-neutral-100 outline-none focus:border-emerald-400/50" /></label><button type="button" disabled={busy || !name.trim() || name.trim() === profile?.display_name} onClick={() => void saveName()} className="rounded-lg bg-emerald-500 px-3.5 py-2.5 text-sm font-medium text-neutral-950 disabled:opacity-50">{busy && !photo ? 'Saving…' : 'Save changes'}</button><button type="button" disabled={busy || (!photo && name === profile?.display_name)} onClick={() => { setName(profile?.display_name ?? user?.displayName ?? ''); setPhoto(null); setPhotoPreview(null); if (previewRef.current) URL.revokeObjectURL(previewRef.current); previewRef.current = null; setError(null); setMessage(null); }} className="rounded-lg border border-white/10 px-3.5 py-2.5 text-sm text-neutral-300 disabled:opacity-40">Cancel</button></div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-white/10 bg-neutral-900/50 p-5" aria-labelledby="account-details-title">
          <h2 id="account-details-title" className="text-sm font-semibold text-neutral-200">Account information</h2>
          <dl className="mt-4 divide-y divide-white/[0.06] text-sm">
            <div className="flex justify-between gap-4 py-3"><dt className="text-neutral-500">Name</dt><dd className="truncate text-right text-neutral-200">{user?.displayName || 'Unavailable'}</dd></div>
            <div className="flex justify-between gap-4 py-3"><dt className="text-neutral-500">Email</dt><dd className="truncate text-right text-neutral-200">{user?.email || 'Unavailable'}</dd></div>
            <div className="flex justify-between gap-4 py-3"><dt className="text-neutral-500">Role</dt><dd className="text-right text-neutral-200">{role}</dd></div>
            <div className="flex justify-between gap-4 py-3"><dt className="text-neutral-500">Account ID</dt><dd className="max-w-[65%] break-all text-right font-mono text-xs text-neutral-400">{user?.id || 'Unavailable'}</dd></div>
            <div className="flex justify-between gap-4 py-3"><dt className="text-neutral-500">Created</dt><dd className="text-right text-neutral-500">{profile?.created_at ? new Date(profile.created_at).toLocaleDateString() : 'Loading…'}</dd></div>
          </dl>
        </section>

        <div className="flex flex-col gap-4">
          <section className="rounded-xl border border-white/10 bg-neutral-900/50 p-5" aria-labelledby="preferences-title">
            <div className="flex items-center justify-between gap-3"><h2 id="preferences-title" className="text-sm font-semibold text-neutral-200">Editor preferences</h2><Link to="/settings" className="text-xs font-medium text-emerald-300 hover:text-emerald-200">Open settings</Link></div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-xs"><div><dt className="text-neutral-500">Theme</dt><dd className="mt-1 capitalize text-neutral-300">{theme}</dd></div><div><dt className="text-neutral-500">Font size</dt><dd className="mt-1 text-neutral-300">{fontSize}px</dd></div><div><dt className="text-neutral-500">Word wrap</dt><dd className="mt-1 capitalize text-neutral-300">{wordWrap}</dd></div><div><dt className="text-neutral-500">Default language</dt><dd className="mt-1 capitalize text-neutral-300">{defaultLanguage}</dd></div></dl>
          </section>
          <section className="rounded-xl border border-white/10 bg-neutral-900/50 p-5" aria-labelledby="security-title">
            <h2 id="security-title" className="text-sm font-semibold text-neutral-200">Security</h2>
            <p className="mt-2 text-xs leading-5 text-neutral-500">Password changes and active-session management are not available through the current authentication API.</p>
            <button type="button" onClick={() => { logout(); navigate('/login', { replace: true }); }} className="mt-4 rounded-lg border border-rose-400/25 px-3.5 py-2 text-sm font-medium text-rose-300 transition hover:bg-rose-400/10">Log out</button>
          </section>
        </div>
      </div>
    </div>
  );
}
