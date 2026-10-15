import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronDown, LogOut, ShieldCheck, UserRound } from 'lucide-react';
import { useAuthStore } from '../../state/authStore';
import { fetchMyProfilePhoto, getMyProfile } from '../../api/profile';

function initials(name: string | undefined) {
  return name?.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'GH';
}

export function UserProfileMenu() {
  const user = useAuthStore((state) => state.user);
  const adminVerified = useAuthStore((state) => state.adminVerified);
  const logout = useAuthStore((state) => state.logout);
  const updateProfile = useAuthStore((state) => state.updateProfile);
  const navigate = useNavigate();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 64, right: 12 });

  const updatePosition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menuHeight = adminVerified ? 300 : 260;
    setPosition({
      top: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - menuHeight - 8)),
      right: Math.max(8, window.innerWidth - rect.right),
    });
  }, [adminVerified]);

  useEffect(() => {
    if (user?.token) {
      let active = true;
      void getMyProfile(user.token).then((profile) => {
        if (active) updateProfile({ id: profile.user_id, displayName: profile.display_name, email: profile.email, roles: profile.roles, createdAt: profile.created_at, photoUrl: profile.profile_photo_url });
      }).catch(() => undefined);
      return () => { active = false; };
    }
  }, [user?.id, user?.token, updateProfile]);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    window.addEventListener('pointerdown', closeOnOutsidePointer);
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePointer);
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);

  const close = () => setOpen(false);
  const logoutAndNavigate = () => {
    close();
    logout();
    navigate('/login', { replace: true });
  };

  return <>
    <button
      ref={buttonRef}
      type="button"
      onClick={() => {
        if (!open) updatePosition();
        setOpen((value) => !value);
      }}
      className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-neutral-800 text-xs font-semibold text-emerald-200 transition hover:border-emerald-400/30 hover:bg-neutral-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400"
      title={user?.displayName || 'User menu'}
      aria-label="User menu"
      aria-haspopup="menu"
      aria-expanded={open}
    >
      <Avatar name={user?.displayName} token={user?.token} photoUrl={user?.photoUrl} size="button" />
      <ChevronDown size={11} className="sr-only" />
    </button>
    {open && createPortal(
      <div
        ref={menuRef}
        role="menu"
        aria-label="User account"
        style={{ top: position.top, right: position.right }}
        className="fixed z-50 max-h-[calc(100dvh-1rem)] w-[min(18rem,calc(100vw-1rem))] overflow-y-auto rounded-xl border border-white/10 bg-neutral-900/95 p-2 shadow-2xl shadow-black/50 backdrop-blur-xl"
      >
        <div className="flex items-center gap-3 border-b border-white/[0.08] px-3 py-3">
          <Avatar name={user?.displayName} token={user?.token} photoUrl={user?.photoUrl} />
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-neutral-100">{user?.displayName || 'GlassHouse user'}</span>{user?.email && <span className="block truncate text-xs text-neutral-500">{user.email}</span>}<span className="mt-1 inline-flex items-center gap-1 text-[10px] text-neutral-500">{adminVerified && <ShieldCheck size={11} className="text-emerald-300" />}{adminVerified ? 'Admin' : user?.roles?.join(', ') || 'Role loading'}</span></span>
        </div>
        <div className="py-1.5">
          <Link role="menuitem" to="/profile" onClick={close} className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-neutral-300 outline-none hover:bg-white/[0.06] hover:text-white focus:bg-white/[0.06] focus:text-white"><UserRound size={15} />My Profile</Link>
          {adminVerified && <Link role="menuitem" to="/admin" onClick={close} className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-neutral-300 outline-none hover:bg-white/[0.06] hover:text-white focus:bg-white/[0.06] focus:text-white"><ShieldCheck size={15} />Admin Dashboard</Link>}
        </div>
        <div className="border-t border-white/[0.08] pt-1.5">
          <button role="menuitem" type="button" onClick={logoutAndNavigate} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-rose-300 outline-none hover:bg-rose-400/[0.08] focus:bg-rose-400/[0.08]"><LogOut size={15} />Log out</button>
        </div>
      </div>,
      document.body,
    )}
  </>;
}

function Avatar({ name, token, photoUrl, size = 'menu' }: { name?: string; token?: string; photoUrl?: string | null; size?: 'menu' | 'button' }) {
  const [loaded, setLoaded] = useState<{ key: string; src: string } | null>(null);
  useEffect(() => {
    if (!token || !photoUrl) return;
    let active = true;
    let objectUrl: string | null = null;
    void fetchMyProfilePhoto(token, photoUrl).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setLoaded({ key: photoUrl, src: objectUrl });
    }).catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [token, photoUrl]);
  const dimensions = size === 'menu' ? 'h-10 w-10' : 'h-9 w-9';
  const src = loaded && loaded.key === photoUrl ? loaded.src : null;
  return src
    ? <img src={src} alt="" className={`${dimensions} shrink-0 rounded-full border border-emerald-300/25 object-cover`} />
    : <span aria-hidden="true" className={`flex ${dimensions} shrink-0 items-center justify-center rounded-full border border-emerald-300/25 bg-emerald-400/10 text-xs font-semibold text-emerald-200`}>{initials(name)}</span>;
}
