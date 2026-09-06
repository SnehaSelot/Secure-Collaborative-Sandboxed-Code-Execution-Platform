import { NavLink } from 'react-router-dom';
import type { ReactNode } from 'react';

type Badge = 'Coming Soon' | 'Preview' | 'Backend Required';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  badge?: Badge;
}

const ICONS = {
  editor: (
    <path
      d="M4 5h16M4 12h10M4 19h16"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  ),
  sessions: (
    <path
      d="M4 6h16v12H4z M8 10h8M8 14h5"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  collaboration: (
    <path
      d="M9 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM17 11a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3 20c0-3 2.5-5 6-5s6 2 6 5M15.5 15.5c2.9.3 4.5 2 4.5 4.5"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  risk: (
    <path
      d="M12 3 3 20h18L12 3ZM12 10v4M12 17h.01"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  admin: (
    <path
      d="M4 20V10M10 20V4M16 20v-7M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  settings: (
    <path
      d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 13a7.4 7.4 0 0 0 0-2l2-1.5-2-3.4-2.3.9a7.5 7.5 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.5 7.5 0 0 0-1.7 1l-2.3-.9-2 3.4L6.6 11a7.4 7.4 0 0 0 0 2l-2 1.5 2 3.4 2.3-.9c.5.4 1.1.75 1.7 1l.4 2.5h4l.4-2.5c.6-.25 1.2-.6 1.7-1l2.3.9 2-3.4-2-1.5Z"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinejoin="round"
    />
  ),
} as const;

const NAV_ITEMS: NavItem[] = [
  { to: '/editor', label: 'Editor', icon: ICONS.editor },
  { to: '/sessions', label: 'Sessions', icon: ICONS.sessions, badge: 'Coming Soon' },
  {
    to: '/collaboration',
    label: 'Collaboration',
    icon: ICONS.collaboration,
    badge: 'Coming Soon',
  },
  { to: '/risk', label: 'Risk Analysis', icon: ICONS.risk, badge: 'Preview' },
  { to: '/admin', label: 'Admin', icon: ICONS.admin, badge: 'Backend Required' },
];

const BADGE_STYLES: Record<Badge, string> = {
  'Coming Soon': 'bg-white/5 text-neutral-400 border-white/10',
  Preview: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  'Backend Required': 'bg-red-500/10 text-red-400 border-red-500/20',
};

export function Sidebar() {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-white/10 bg-neutral-950/60 max-md:hidden">
      <nav className="flex-1 space-y-1 p-3">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-md px-3 py-2 text-sm transition ${
                isActive
                  ? 'bg-emerald-500/10 text-emerald-400'
                  : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-100'
              }`
            }
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
              className="shrink-0"
            >
              {item.icon}
            </svg>
            <span className="flex-1 truncate">{item.label}</span>
            {item.badge && (
              <span
                className={`rounded-full border px-1.5 py-0.5 text-[10px] leading-none whitespace-nowrap ${BADGE_STYLES[item.badge]}`}
              >
                {item.badge}
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-white/10 p-3">
        <button
          type="button"
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-neutral-500 transition hover:bg-white/5 hover:text-neutral-300"
          title="Settings — coming soon, no persistence backend yet"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            {ICONS.settings}
          </svg>
          <span className="flex-1 text-left">Settings</span>
          <span className="rounded-full border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] leading-none text-neutral-400">
            Coming Soon
          </span>
        </button>
      </div>
    </aside>
  );
}