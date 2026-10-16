import { useHealth } from '../../hooks/useHealth';
import { UserProfileMenu } from './UserProfileMenu';

/**
 * BACKEND INTEGRATION:
 * Endpoint: GET /health (via useHealth)
 * Status: Available
 * Displays live connection status — never hardcoded to "online".
 */
export function Header() {
  const status = useHealth();

  const statusConfig = {
    checking: { label: 'Connecting…', dotClass: 'bg-amber-400 animate-pulse' },
    online: { label: 'Backend Online', dotClass: 'bg-emerald-400' },
    offline: { label: 'Backend Offline', dotClass: 'bg-red-500' },
  } as const;

  const { label, dotClass } = statusConfig[status];

  return (
    <header className="relative z-40 flex h-14 shrink-0 items-center justify-between border-b border-white/10 bg-neutral-900/80 px-4 backdrop-blur">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-400">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 2 4 6v6c0 5 3.4 8.7 8 10 4.6-1.3 8-5 8-10V6l-8-4Z"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold tracking-tight text-neutral-100">
            GlassHouse
          </span>
          <span className="hidden text-xs text-neutral-500 sm:inline">
            Secure Sandboxed Execution
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div
          className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-neutral-300"
          role="status"
          aria-live="polite"
        >
          <span className={`h-2 w-2 rounded-full ${dotClass}`} aria-hidden="true" />
          {label}
        </div>
        <UserProfileMenu />
      </div>
    </header>
  );
}
