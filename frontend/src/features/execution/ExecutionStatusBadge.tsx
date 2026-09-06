import type { ExecutionStatus } from '../../api/types';

type BadgeState = ExecutionStatus | 'running' | 'idle';

interface ExecutionStatusBadgeProps {
  status: BadgeState;
}

const STATUS_CONFIG: Record<BadgeState, { label: string; className: string }> = {
  idle: { label: 'Idle', className: 'bg-white/5 text-neutral-400 border-white/10' },
  running: {
    label: 'Running',
    className: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  },
  success: {
    label: 'Success',
    className: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  },
  error: { label: 'Error', className: 'bg-red-500/10 text-red-400 border-red-500/20' },
  timeout: {
    label: 'Timeout',
    className: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  },
  internal_error: {
    label: 'Backend Error',
    className: 'bg-red-500/10 text-red-400 border-red-500/20',
  },
};

export function ExecutionStatusBadge({ status }: ExecutionStatusBadgeProps) {
  const { label, className } = STATUS_CONFIG[status];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${className}`}
    >
      {label}
    </span>
  );
}