import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  Activity,
  Code2,
  FileText,
  PanelLeftClose,
  PanelLeftOpen,
  Radio,
  Shield,
  ShieldAlert,
  Terminal,
  Users,
} from 'lucide-react';

interface AdminNavItem {
  to: string;
  label: string;
  icon: typeof Activity;
  end?: boolean;
}

const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  { to: '/admin', label: 'Overview', icon: Activity, end: true },
  { to: '/admin/sessions', label: 'Session Monitoring', icon: Radio },
  { to: '/admin/executions', label: 'Execution History', icon: Terminal },
  { to: '/admin/audit', label: 'Audit Trail', icon: FileText },
  { to: '/admin/flagged', label: 'Flagged Events / Risk Review', icon: ShieldAlert },
  { to: '/admin/users', label: 'User Directory', icon: Users },
];

export function AdminSidebar() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={`flex shrink-0 flex-col border-r border-white/10 bg-neutral-950/70 transition-[width] duration-200 max-md:hidden ${
        collapsed ? 'w-16' : 'w-64'
      }`}
    >
      {/* Admin console indicator */}
      <div className="border-b border-white/10 px-4 py-3">
        <div className={`flex items-center gap-2.5 ${collapsed ? 'justify-center' : ''}`}>
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-400">
            <Shield size={16} />
          </div>
          {!collapsed && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
                Administration
              </p>
              <p className="text-[11px] text-neutral-500">Security & Governance</p>
            </div>
          )}
        </div>
      </div>

      {/* Navigation items */}
      <nav className="flex-1 space-y-1 p-3">
        {ADMIN_NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              title={collapsed ? item.label : undefined}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-md px-3 py-2 text-sm transition ${
                  collapsed ? 'justify-center' : ''
                } ${
                  isActive
                    ? 'bg-emerald-500/10 font-medium text-emerald-400'
                    : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-100'
                }`
              }
            >
              <Icon size={16} className="shrink-0" />
              {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
            </NavLink>
          );
        })}
      </nav>

      {/* Bottom section: Developer link and collapse toggle */}
      <div className="border-t border-white/10 p-3 space-y-1">
        <NavLink
          to="/editor"
          title={collapsed ? 'Developer Workspace' : undefined}
          className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-neutral-400 transition hover:bg-white/5 hover:text-neutral-100 ${
            collapsed ? 'justify-center' : ''
          }`}
        >
          <Code2 size={16} className="shrink-0" />
          {!collapsed && <span className="flex-1 truncate">Developer Workspace</span>}
        </NavLink>

        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-neutral-500 transition hover:bg-white/5 hover:text-neutral-300 ${
            collapsed ? 'justify-center' : ''
          }`}
        >
          {collapsed ? (
            <PanelLeftOpen size={16} className="shrink-0" />
          ) : (
            <PanelLeftClose size={16} className="shrink-0" />
          )}
          {!collapsed && <span className="flex-1 text-left">Collapse</span>}
        </button>
      </div>
    </aside>
  );
}

