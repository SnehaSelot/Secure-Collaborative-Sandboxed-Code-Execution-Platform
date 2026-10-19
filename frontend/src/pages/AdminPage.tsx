import { useCallback, useEffect, useState, type FormEvent } from 'react';
import axios from 'axios';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { apiClient } from '../api/client';
import { useAuthStore } from '../state/authStore';

interface AdminOverview {
  active_sessions: number;
  recent_sessions: number;
  hibernated_sessions: number;
  closed_sessions: number;
  total_executions: number;
  successful_executions: number;
  finished_executions: number;
  execution_success_rate: number | null;
  execution_activity: { day: string; executions: number; successful_executions: number }[];
}
interface AdminHealth { database: string; collaboration: string; collaboration_clients: number | null }
interface AdminSession {
  id: string; name: string; status: string; created_at: string; last_active_at: string;
  owner_name: string; owner_email: string; active_participants: number;
}
interface AdminSessionDetail extends AdminSession {
  participants: { user_id: string; display_name: string | null; joined_at: string; left_at: string | null }[];
}
interface AdminAudit {
  id: number; created_at: string; user_id: string | null; user_name: string | null;
  user_email: string | null; session_id: string | null; session_name: string | null;
  action: string; entity_type: string; entity_id: string; metadata: Record<string, unknown> | null;
  risk_score: number | null; risk_decision: string | null;
}
interface AdminUser {
  id: string; email: string; display_name: string; created_at: string; roles: string[];
  account_status?: 'active' | 'disabled';
}

const cardClass = 'rounded-xl border border-white/10 bg-neutral-900/60 p-5';
const tableClass = 'w-full min-w-[760px] text-left text-sm';
const headersFor = (token: string) => ({ Authorization: `Bearer ${token}` });
const formatDate = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : '—';
const healthPresentation = (status: string) => {
  if (status === 'online' || status === 'ok' || status === 'healthy') return { label: 'Healthy', color: 'text-emerald-300', dot: 'bg-emerald-400' };
  if (status === 'offline') return { label: 'Offline', color: 'text-rose-300', dot: 'bg-rose-400' };
  if (status === 'checking') return { label: 'Checking', color: 'text-neutral-400', dot: 'bg-neutral-500' };
  return { label: 'Degraded', color: 'text-amber-300', dot: 'bg-amber-400' };
};

const ADMIN_TABS = [
  { id: 'overview', label: 'Overview', to: '/admin' },
  { id: 'sessions', label: 'Session Monitoring', to: '/admin/sessions' },
  { id: 'audit', label: 'Audit Trail', to: '/admin/audit' },
  { id: 'users', label: 'User Directory', to: '/admin/users' },
] as const;

export function AdminPage() {
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const navigate = useNavigate();
  const { section } = useParams<{ section?: string }>();
  const validTabs = ['overview', 'sessions', 'audit', 'users'];
  const activeTab = validTabs.includes(section || '') ? (section || 'overview') : 'overview';

  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [health, setHealth] = useState<AdminHealth | null>(null);
  const [backendStatus, setBackendStatus] = useState('checking');
  const [recentActivity, setRecentActivity] = useState<AdminAudit[]>([]);
  const [overviewUpdatedAt, setOverviewUpdatedAt] = useState<Date | null>(null);
  const [overviewError, setOverviewError] = useState('');
  const [activityRange, setActivityRange] = useState(7);
  const [refreshing, setRefreshing] = useState(false);
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [sessionDetail, setSessionDetail] = useState<AdminSessionDetail | null>(null);
  const [pendingTermination, setPendingTermination] = useState<AdminSession | null>(null);
  const [terminating, setTerminating] = useState(false);
  const [sessionActionError, setSessionActionError] = useState('');
  const [pendingUserStatus, setPendingUserStatus] = useState<{ user: AdminUser; newStatus: 'active' | 'disabled' } | null>(null);
  const [updatingUserStatus, setUpdatingUserStatus] = useState(false);
  const [userActionError, setUserActionError] = useState('');
  const [audit, setAudit] = useState<AdminAudit[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [auditLoading, setAuditLoading] = useState(false);
  const [error, setError] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [sessionFilter, setSessionFilter] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [riskLevel, setRiskLevel] = useState('');

  const handleAuthorizationError = useCallback((requestError: unknown) => {
    if (axios.isAxiosError(requestError) && requestError.response?.status === 401) {
      logout();
      navigate('/login', { replace: true, state: { message: 'Your session expired. Please sign in again.' } });
      return true;
    }
    if (axios.isAxiosError(requestError) && requestError.response?.status === 403) {
      navigate('/editor', { replace: true, state: { message: 'Administrator access is required.' } });
      return true;
    }
    return false;
  }, [logout, navigate]);

  const loadDashboard = useCallback(async (refresh = false) => {
    if (!user) return;
    if (refresh) setRefreshing(true);
    const config = { headers: headersFor(user.token) };
    try {
      const [overviewRes, sessionRes, auditRes, userRes, healthRes, backendRes] = await Promise.allSettled([
        apiClient.get<AdminOverview>(`/admin/overview?days=${activityRange}`, config),
        apiClient.get<AdminSession[]>('/admin/sessions', config),
        apiClient.get<AdminAudit[]>('/admin/audit', config),
        apiClient.get<AdminUser[]>('/admin/users', config),
        apiClient.get<AdminHealth>('/admin/health', config),
        apiClient.get<{ status?: string }>('/health'),
      ]);

      if (overviewRes.status === 'fulfilled') {
        setOverview(overviewRes.value.data);
        setOverviewError('');
      } else {
        if (!handleAuthorizationError(overviewRes.reason)) {
          setOverviewError('Overview metrics are unavailable.');
        }
      }

      if (sessionRes.status === 'fulfilled') {
        setSessions(sessionRes.value.data);
      } else {
        handleAuthorizationError(sessionRes.reason);
      }

      if (auditRes.status === 'fulfilled') {
        setAudit(auditRes.value.data);
        setRecentActivity(auditRes.value.data.slice(0, 8));
      } else {
        handleAuthorizationError(auditRes.reason);
      }

      if (userRes.status === 'fulfilled') {
        setUsers(userRes.value.data);
      } else {
        handleAuthorizationError(userRes.reason);
      }

      if (healthRes.status === 'fulfilled') {
        setHealth(healthRes.value.data);
      } else {
        setHealth(null);
      }

      if (backendRes.status === 'fulfilled') {
        setBackendStatus(backendRes.value.data.status ?? 'degraded');
      } else {
        setBackendStatus('offline');
      }

      setOverviewUpdatedAt(new Date());
      setError('');
    } catch (requestError) {
      if (!handleAuthorizationError(requestError)) {
        setError('The admin dashboard data could not be loaded. Please try again.');
        setOverviewError('Overview data is unavailable. Refresh to try again.');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activityRange, handleAuthorizationError, user]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadDashboard(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadDashboard]);

  const applyAuditFilters = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user) return;
    setAuditLoading(true);
    const params = new URLSearchParams();
    if (userFilter) params.set('user_id', userFilter);
    if (sessionFilter) params.set('session_id', sessionFilter);
    if (startDate) params.set('start_date', `${startDate}T00:00:00Z`);
    if (endDate) params.set('end_date', `${endDate}T23:59:59Z`);
    if (riskLevel) params.set('risk_level', riskLevel);
    try {
      const response = await apiClient.get<AdminAudit[]>(`/admin/audit?${params.toString()}`, { headers: headersFor(user.token) });
      setAudit(response.data);
    } catch (requestError) {
      if (!handleAuthorizationError(requestError)) setError('The audit trail could not be filtered. Please try again.');
    } finally {
      setAuditLoading(false);
    }
  };

  const resetAuditFilters = async () => {
    setUserFilter('');
    setSessionFilter('');
    setStartDate('');
    setEndDate('');
    setRiskLevel('');
    if (!user) return;
    setAuditLoading(true);
    try {
      const response = await apiClient.get<AdminAudit[]>('/admin/audit', { headers: headersFor(user.token) });
      setAudit(response.data);
    } catch (requestError) {
      if (!handleAuthorizationError(requestError)) setError('The audit trail could not be reloaded. Please try again.');
    } finally {
      setAuditLoading(false);
    }
  };

  const viewSession = async (sessionId: string) => {
    if (!user) return;
    try {
      const response = await apiClient.get<AdminSessionDetail>(`/admin/sessions/${sessionId}`, { headers: headersFor(user.token) });
      setSessionDetail(response.data);
      setSessionActionError('');
    } catch (requestError) {
      if (!handleAuthorizationError(requestError)) setSessionActionError('Session details could not be loaded. Please try again.');
    }
  };

  const terminateSession = async (session: AdminSession) => {
    if (!user || terminating) return;
    setTerminating(true);
    try {
      await apiClient.post(`/admin/sessions/${session.id}/terminate`, {}, { headers: headersFor(user.token) });
      setSessions((current) => current.map((item) => item.id === session.id ? { ...item, status: 'closed', active_participants: 0 } : item));
      setSessionDetail((current) => current?.id === session.id ? { ...current, status: 'closed', active_participants: 0 } : current);
      setOverview((curr) => curr ? {
        ...curr,
        active_sessions: Math.max(0, curr.active_sessions - 1),
        closed_sessions: curr.closed_sessions + 1,
      } : curr);
      setPendingTermination(null);
      setSessionActionError('');
    } catch (requestError) {
      if (!handleAuthorizationError(requestError)) setSessionActionError('Session could not be terminated. Refresh and try again.');
    } finally {
      setTerminating(false);
    }
  };

  const toggleUserStatus = async (targetUser: AdminUser, newStatus: 'active' | 'disabled') => {
    if (!user || updatingUserStatus) return;
    setUpdatingUserStatus(true);
    try {
      await apiClient.post(
        `/admin/users/${targetUser.id}/status`,
        { account_status: newStatus },
        { headers: headersFor(user.token) }
      );
      setUsers((current) =>
        current.map((item) =>
          item.id === targetUser.id ? { ...item, account_status: newStatus } : item
        )
      );
      setPendingUserStatus(null);
      setUserActionError('');
    } catch (requestError) {
      if (!handleAuthorizationError(requestError)) {
        setUserActionError('User account status could not be updated. Please try again.');
      }
    } finally {
      setUpdatingUserStatus(false);
    }
  };

  if (!user) return null;

  const pageTitles: Record<string, { title: string; subtitle: string }> = {
    overview: {
      title: 'Overview',
      subtitle: 'System vitals and high-level platform activity.',
    },
    sessions: {
      title: 'Session Monitoring',
      subtitle: 'Most recently active collaboration sessions.',
    },
    audit: {
      title: 'Audit Trail',
      subtitle: 'Read-only audit entries; this dashboard does not edit or delete them.',
    },
    users: {
      title: 'User Directory',
      subtitle: 'Read-only account identity and database-assigned roles.',
    },
  };
  const headerInfo = pageTitles[activeTab] || pageTitles.overview;

  const showOverview = activeTab === 'overview';
  const showSessions = activeTab === 'sessions';
  const showAudit = activeTab === 'audit';
  const showUsers = activeTab === 'users';
  const executionActivity = overview?.execution_activity ?? [];
  const hasExecutionActivity = executionActivity.some((point) => point.executions > 0);
  const maxDailyExecutions = Math.max(1, ...executionActivity.map((point) => point.executions));
  const activityLabelInterval = Math.max(1, Math.ceil(activityRange / 7));

  const totalSessions = overview ? overview.active_sessions + overview.hibernated_sessions + overview.closed_sessions : 0;
  const activeDash = totalSessions > 0 ? (overview!.active_sessions / totalSessions) * 276.46 : 0;
  const hibernatedDash = totalSessions > 0 ? (overview!.hibernated_sessions / totalSessions) * 276.46 : 0;
  const closedDash = totalSessions > 0 ? (overview!.closed_sessions / totalSessions) * 276.46 : 0;

  const totalExecutions = overview?.total_executions ?? 0;
  const successfulExecutions = overview?.successful_executions ?? 0;
  const otherExecutions = Math.max(0, totalExecutions - successfulExecutions);
  const successDash = totalExecutions > 0 ? (successfulExecutions / totalExecutions) * 276.46 : 0;
  const otherDash = totalExecutions > 0 ? (otherExecutions / totalExecutions) * 276.46 : 0;

  return (
    <section className="mx-auto w-full max-w-[1440px] space-y-7 p-5 sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <header>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300">GlassHouse Administration</p>
          <h1 className="mt-2 text-2xl font-semibold">{headerInfo.title}</h1>
          <p className="mt-1 text-sm text-neutral-500">{headerInfo.subtitle}</p>
        </header>
        <div className="flex items-center gap-3">
          {overviewUpdatedAt && (
            <span className="text-xs text-neutral-500">Updated {overviewUpdatedAt.toLocaleTimeString()}</span>
          )}
          <button
            type="button"
            onClick={() => void loadDashboard(true)}
            disabled={refreshing}
            className="rounded-md border border-white/10 px-3 py-2 text-xs font-medium text-neutral-200 hover:bg-white/5 disabled:opacity-50"
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Navigation tabs for quick switching between admin views */}
      <nav aria-label="Admin views" className="flex flex-wrap items-center gap-2 border-b border-white/10 pb-4">
        {ADMIN_TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <Link
              key={tab.id}
              to={tab.to}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                isActive
                  ? 'border border-emerald-500/30 bg-emerald-500/15 text-emerald-300'
                  : 'border border-transparent text-neutral-400 hover:bg-white/5 hover:text-neutral-200'
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>

      {error && <div role="alert" className="rounded-lg border border-rose-400/20 bg-rose-400/[0.06] p-4 text-sm text-rose-200">{error}</div>}
      {sessionActionError && <div role="alert" className="rounded-lg border border-rose-400/20 bg-rose-400/[0.06] p-4 text-sm text-rose-200">{sessionActionError}</div>}
      {userActionError && <div role="alert" className="rounded-lg border border-rose-400/20 bg-rose-400/[0.06] p-4 text-sm text-rose-200">{userActionError}</div>}

      {loading ? (
        <p role="status" className="text-sm text-neutral-400">Loading admin data…</p>
      ) : (
        <>
          {showOverview && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs text-neutral-500">
                  <label htmlFor="overview-range">Chart range</label>
                  <select
                    id="overview-range"
                    value={activityRange}
                    onChange={(event) => setActivityRange(Number(event.target.value))}
                    className="rounded-md border border-white/10 bg-[#080d11] px-2.5 py-2 text-neutral-200"
                  >
                    <option value={7}>Last 7 days</option>
                    <option value={14}>Last 14 days</option>
                    <option value={30}>Last 30 days</option>
                  </select>
                </div>
              </div>
              {overviewError && <div role="alert" className="rounded-lg border border-rose-400/20 bg-rose-400/[0.06] p-4 text-sm text-rose-200">{overviewError}</div>}
              {!overview ? (
                <div className={cardClass}>
                  <p className="text-sm text-neutral-400">Overview metrics are unavailable.</p>
                </div>
              ) : (
                <>
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    {[
                      ['Active sessions', overview.active_sessions, 'Currently open'],
                      ['Sessions created · 7d', overview.recent_sessions, 'Fixed seven-day metric'],
                      ['Total executions', overview.total_executions, 'Persisted execution records'],
                      [
                        'Success rate',
                        overview.execution_success_rate == null ? '—' : `${overview.execution_success_rate}%`,
                        overview.finished_executions
                          ? `${overview.successful_executions} of ${overview.finished_executions} finished`
                          : 'No finished runs',
                      ],
                    ].map(([label, value, description]) => (
                      <article key={String(label)} className={cardClass}>
                        <p className="text-sm text-neutral-500">{label}</p>
                        <p className="mt-2 text-3xl font-semibold text-neutral-100">{value}</p>
                        <p className="mt-1 text-xs text-neutral-600">{description}</p>
                      </article>
                    ))}
                  </div>
                  <div className="grid gap-5 xl:grid-cols-3">
                    <section className={`${cardClass} xl:col-span-2`}>
                      <div className="mb-4 flex items-start justify-between">
                        <div>
                          <h2 className="text-lg font-semibold">Execution activity</h2>
                          <p className="mt-1 text-xs text-neutral-500">Daily persisted runs; date labels use the selected chart range</p>
                        </div>
                        <span className="text-xs text-neutral-600">{activityRange} days</span>
                      </div>
                      {!hasExecutionActivity ? (
                        <p className="py-12 text-center text-sm text-neutral-500">
                          No execution records in the selected {activityRange}-day range.
                        </p>
                      ) : (
                        <div
                          className="flex h-56 min-w-0 items-end gap-1 border-b border-white/10 pb-2"
                          role="group"
                          aria-label={`Execution activity for the last ${activityRange} days`}
                        >
                          {executionActivity.map((point, index) => {
                            const height = point.executions > 0 ? Math.max(4, Math.round((point.executions / maxDailyExecutions) * 100)) : 0;
                            const rate = point.executions ? Math.round((point.successful_executions / point.executions) * 100) : 0;
                            const date = new Date(`${point.day}T12:00:00`);
                            const showLabel = index % activityLabelInterval === 0 || index === executionActivity.length - 1;
                            return (
                              <button
                                key={String(point.day)}
                                type="button"
                                title={`${date.toLocaleDateString()}: ${point.executions} executions, ${point.successful_executions} successful`}
                                className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"
                                aria-label={`${date.toLocaleDateString()}: ${point.executions} executions, ${rate}% success`}
                              >
                                <span className="hidden text-[10px] text-neutral-400 group-hover:block">{point.executions}</span>
                                {height > 0 ? (
                                  <span
                                    className="w-full rounded-t bg-emerald-400/70 transition-colors group-hover:bg-emerald-300"
                                    style={{ height: `${height}%` }}
                                  />
                                ) : (
                                  <span className="h-0.5 w-full bg-white/10" />
                                )}
                                <span className="h-3 whitespace-nowrap text-[9px] text-neutral-500">
                                  {showLabel ? date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }) : ''}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </section>
                    <section className={cardClass}>
                      <h2 className="text-lg font-semibold">Session status</h2>
                      <p className="mt-1 text-xs text-neutral-500">Current state of recorded sessions</p>
                      <div className="my-5 flex items-center justify-center">
                        <svg viewBox="0 0 120 120" className="h-36 w-36" role="img" aria-label="Session status donut chart">
                          <circle cx="60" cy="60" r="44" fill="none" stroke="#252a2d" strokeWidth="16" />
                          {totalSessions > 0 && (
                            <>
                              {activeDash > 0 && (
                                <circle
                                  cx="60"
                                  cy="60"
                                  r="44"
                                  fill="none"
                                  stroke="#34d399"
                                  strokeWidth="16"
                                  strokeDasharray={`${activeDash} ${276.46 - activeDash}`}
                                  strokeDashoffset="0"
                                  transform="rotate(-90 60 60)"
                                />
                              )}
                              {hibernatedDash > 0 && (
                                <circle
                                  cx="60"
                                  cy="60"
                                  r="44"
                                  fill="none"
                                  stroke="#fbbf24"
                                  strokeWidth="16"
                                  strokeDasharray={`${hibernatedDash} ${276.46 - hibernatedDash}`}
                                  strokeDashoffset={-activeDash}
                                  transform="rotate(-90 60 60)"
                                />
                              )}
                              {closedDash > 0 && (
                                <circle
                                  cx="60"
                                  cy="60"
                                  r="44"
                                  fill="none"
                                  stroke="#737373"
                                  strokeWidth="16"
                                  strokeDasharray={`${closedDash} ${276.46 - closedDash}`}
                                  strokeDashoffset={-(activeDash + hibernatedDash)}
                                  transform="rotate(-90 60 60)"
                                />
                              )}
                            </>
                          )}
                          <text x="60" y="58" textAnchor="middle" fill="white" fontSize="20">{totalSessions}</text>
                          <text x="60" y="75" textAnchor="middle" fill="#737373" fontSize="9">sessions</text>
                        </svg>
                      </div>
                      <div className="space-y-2 text-sm">
                        <div className="flex justify-between"><span className="text-emerald-300">● Active</span><b>{overview.active_sessions}</b></div>
                        <div className="flex justify-between"><span className="text-amber-300">● Hibernated</span><b>{overview.hibernated_sessions}</b></div>
                        <div className="flex justify-between"><span className="text-neutral-500">● Closed</span><b>{overview.closed_sessions}</b></div>
                      </div>
                    </section>
                    <section className={cardClass}>
                      <h2 className="text-lg font-semibold">Execution outcomes</h2>
                      <p className="mt-1 text-xs text-neutral-500">Successful vs other recorded statuses</p>
                      {totalExecutions === 0 ? (
                        <p className="py-12 text-center text-sm text-neutral-500">No persisted execution records.</p>
                      ) : (
                        <>
                          <div className="my-5 flex items-center justify-center">
                            <svg viewBox="0 0 120 120" className="h-36 w-36" role="img" aria-label="Execution outcomes donut chart">
                              <circle cx="60" cy="60" r="44" fill="none" stroke="#252a2d" strokeWidth="16" />
                              {successDash > 0 && (
                                <circle
                                  cx="60"
                                  cy="60"
                                  r="44"
                                  fill="none"
                                  stroke="#34d399"
                                  strokeWidth="16"
                                  strokeDasharray={`${successDash} ${276.46 - successDash}`}
                                  strokeDashoffset="0"
                                  transform="rotate(-90 60 60)"
                                />
                              )}
                              {otherDash > 0 && (
                                <circle
                                  cx="60"
                                  cy="60"
                                  r="44"
                                  fill="none"
                                  stroke="#fb7185"
                                  strokeWidth="16"
                                  strokeDasharray={`${otherDash} ${276.46 - otherDash}`}
                                  strokeDashoffset={-successDash}
                                  transform="rotate(-90 60 60)"
                                />
                              )}
                              <text x="60" y="58" textAnchor="middle" fill="white" fontSize="20">{totalExecutions}</text>
                              <text x="60" y="75" textAnchor="middle" fill="#737373" fontSize="9">executions</text>
                            </svg>
                          </div>
                          <div className="space-y-2 text-sm">
                            <div className="flex justify-between"><span className="text-emerald-300">● Completed</span><b>{overview.successful_executions}</b></div>
                            <div className="flex justify-between"><span className="text-rose-300">● Other statuses</span><b>{otherExecutions}</b></div>
                          </div>
                        </>
                      )}
                    </section>
                    <section className={cardClass}>
                      <h2 className="text-lg font-semibold">System health</h2>
                      <p className="mt-1 text-xs text-neutral-500">Live service checks</p>
                      <div className="mt-5 space-y-4">
                        {[
                          ['API', backendStatus],
                          ['Database', health?.database ?? 'unavailable'],
                          ['Collaboration', health?.collaboration ?? 'unavailable'],
                        ].map(([name, rawStatus]) => {
                          const status = healthPresentation(rawStatus);
                          return (
                            <div key={name} className="flex items-center justify-between border-b border-white/[0.06] pb-3 text-sm">
                              <span className="text-neutral-300">{name}</span>
                              <span className={`inline-flex items-center gap-2 ${status.color}`}>
                                <span className={`h-2 w-2 rounded-full ${status.dot}`} />
                                {status.label}
                              </span>
                            </div>
                          );
                        })}
                        {health?.collaboration_clients != null && (
                          <p className="text-xs text-neutral-500">{health.collaboration_clients} connected clients</p>
                        )}
                      </div>
                    </section>
                    <section className={`${cardClass} xl:col-span-3`}>
                      <div className="mb-4 flex items-center justify-between">
                        <div>
                          <h2 className="text-lg font-semibold">Recent activity</h2>
                          <p className="mt-1 text-xs text-neutral-500">Latest administrative audit events</p>
                        </div>
                        <Link to="/admin/audit" className="text-xs text-emerald-300 hover:text-emerald-200">
                          View audit trail →
                        </Link>
                      </div>
                      {recentActivity.length === 0 ? (
                        <p className="py-4 text-sm text-neutral-500">No audit activity is recorded.</p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full min-w-[600px] text-left text-sm">
                            <thead className="text-xs uppercase tracking-wide text-neutral-500">
                              <tr>
                                <th className="pb-3">Time</th>
                                <th className="pb-3">Actor</th>
                                <th className="pb-3">Action</th>
                                <th className="pb-3">Session</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-white/[0.06]">
                              {recentActivity.map((item) => (
                                <tr key={item.id}>
                                  <td className="py-3 text-neutral-400">{formatDate(item.created_at)}</td>
                                  <td className="py-3">
                                    {item.user_name ?? 'System'}
                                    {item.user_email && <span className="block text-xs text-neutral-500">{item.user_email}</span>}
                                  </td>
                                  <td className="py-3">{item.action}</td>
                                  <td className="py-3">{item.session_name ?? '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </section>
                  </div>
                </>
              )}
            </div>
          )}

          {showSessions && (
            <section className={cardClass}>
              <div className="mb-4">
                <h2 className="text-lg font-semibold">Session monitoring</h2>
                <p className="mt-1 text-xs text-neutral-500">Most recently active collaboration sessions.</p>
              </div>
              <div className="overflow-x-auto">
                <table className={tableClass}>
                  <thead className="text-xs uppercase tracking-wide text-neutral-500">
                    <tr>
                      <th className="pb-3">Session</th>
                      <th className="pb-3">Owner</th>
                      <th className="pb-3">Status</th>
                      <th className="pb-3">Participants</th>
                      <th className="pb-3">Last active</th>
                      <th className="pb-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06]">
                    {sessions.map((item) => (
                      <tr key={item.id}>
                        <td className="py-3">
                          <span className="block text-neutral-200">{item.name}</span>
                          <span className="text-xs text-neutral-600">{item.id}</span>
                        </td>
                        <td className="py-3">
                          <span className="block">{item.owner_name}</span>
                          <span className="text-xs text-neutral-500">{item.owner_email}</span>
                        </td>
                        <td className="py-3 capitalize">{item.status}</td>
                        <td className="py-3">{item.active_participants}</td>
                        <td className="py-3 text-neutral-400">{formatDate(item.last_active_at)}</td>
                        <td className="py-3">
                          <div className="flex gap-2">
                            <button type="button" onClick={() => void viewSession(item.id)} className="text-xs text-emerald-300 hover:text-emerald-200">
                              Details
                            </button>
                            {item.status !== 'closed' && (
                              <button type="button" onClick={() => setPendingTermination(item)} className="text-xs text-rose-300 hover:text-rose-200">
                                Terminate
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {sessions.length === 0 && <p className="py-4 text-sm text-neutral-500">No collaboration sessions are recorded.</p>}
            </section>
          )}

          {sessionDetail && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setSessionDetail(null);
              }}
            >
              <section
                role="dialog"
                aria-modal="true"
                aria-labelledby="session-detail-title"
                className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-white/10 bg-neutral-950 p-6 shadow-2xl"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 id="session-detail-title" className="text-lg font-semibold">{sessionDetail.name}</h2>
                    <p className="mt-1 text-xs text-neutral-500">{sessionDetail.id} · {sessionDetail.status}</p>
                  </div>
                  <button type="button" onClick={() => setSessionDetail(null)} aria-label="Close session details" className="rounded-md px-2 py-1 text-neutral-400 hover:bg-white/5">
                    ×
                  </button>
                </div>
                <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-neutral-500">Owner</dt>
                    <dd>{sessionDetail.owner_name} · {sessionDetail.owner_email}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-neutral-500">Created</dt>
                    <dd>{formatDate(sessionDetail.created_at)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-neutral-500">Last active</dt>
                    <dd>{formatDate(sessionDetail.last_active_at)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-neutral-500">Active participants</dt>
                    <dd>{sessionDetail.active_participants}</dd>
                  </div>
                </dl>
                <h3 className="mt-6 mb-2 text-sm font-medium">Participants</h3>
                {sessionDetail.participants.length ? (
                  <ul className="divide-y divide-white/[0.06]">
                    {sessionDetail.participants.map((participant) => (
                      <li key={`${participant.user_id}-${participant.joined_at}`} className="flex justify-between gap-4 py-2 text-sm">
                        <span>
                          {participant.display_name ?? 'Unknown user'}
                          <span className="block text-xs text-neutral-600">{participant.user_id}</span>
                        </span>
                        <span className="text-right text-xs text-neutral-500">
                          Joined {formatDate(participant.joined_at)}
                          <br />
                          {participant.left_at ? `Left ${formatDate(participant.left_at)}` : 'Currently active'}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-neutral-500">No participants are recorded.</p>
                )}
              </section>
            </div>
          )}

          {pendingTermination && (
            <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" role="presentation">
              <section
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="terminate-session-title"
                aria-describedby="terminate-session-description"
                className="w-full max-w-md rounded-xl border border-white/10 bg-neutral-950 p-6 shadow-2xl"
              >
                <h2 id="terminate-session-title" className="text-lg font-semibold text-neutral-100">Terminate session?</h2>
                <p id="terminate-session-description" className="mt-2 text-sm text-neutral-400">
                  “{pendingTermination.name}” will be closed and its participants will be disconnected. This action will be recorded in the audit trail.
                </p>
                <div className="mt-6 flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => setPendingTermination(null)}
                    disabled={terminating}
                    className="rounded-md border border-white/10 px-4 py-2 text-sm text-neutral-300 hover:bg-white/5 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void terminateSession(pendingTermination)}
                    disabled={terminating}
                    className="rounded-md bg-rose-500 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-400 disabled:opacity-50"
                  >
                    {terminating ? 'Terminating…' : 'Terminate session'}
                  </button>
                </div>
              </section>
            </div>
          )}

          {pendingUserStatus && (
            <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" role="presentation">
              <section
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="user-status-title"
                aria-describedby="user-status-description"
                className="w-full max-w-md rounded-xl border border-white/10 bg-neutral-950 p-6 shadow-2xl"
              >
                <h2 id="user-status-title" className="text-lg font-semibold text-neutral-100">
                  {pendingUserStatus.newStatus === 'disabled' ? 'Disable user account?' : 'Activate user account?'}
                </h2>
                <p id="user-status-description" className="mt-2 text-sm text-neutral-400">
                  {pendingUserStatus.newStatus === 'disabled'
                    ? `“${pendingUserStatus.user.display_name}” (${pendingUserStatus.user.email}) will be prevented from accessing the platform. This action is recorded in the audit trail.`
                    : `“${pendingUserStatus.user.display_name}” (${pendingUserStatus.user.email}) will be restored to active status.`}
                </p>
                <div className="mt-6 flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => setPendingUserStatus(null)}
                    disabled={updatingUserStatus}
                    className="rounded-md border border-white/10 px-4 py-2 text-sm text-neutral-300 hover:bg-white/5 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void toggleUserStatus(pendingUserStatus.user, pendingUserStatus.newStatus)}
                    disabled={updatingUserStatus}
                    className={`rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 ${
                      pendingUserStatus.newStatus === 'disabled'
                        ? 'bg-rose-500 hover:bg-rose-400'
                        : 'bg-emerald-500 hover:bg-emerald-400'
                    }`}
                  >
                    {updatingUserStatus
                      ? 'Updating…'
                      : pendingUserStatus.newStatus === 'disabled'
                      ? 'Disable account'
                      : 'Activate account'}
                  </button>
                </div>
              </section>
            </div>
          )}

          {showAudit && (
            <section className={cardClass}>
              <div className="mb-4">
                <h2 className="text-lg font-semibold">Audit trail</h2>
                <p className="mt-1 text-xs text-neutral-500">Read-only audit entries; this dashboard does not edit or delete them.</p>
              </div>
              <form onSubmit={applyAuditFilters} className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
                <label className="text-xs text-neutral-400">
                  User
                  <select value={userFilter} onChange={(event) => setUserFilter(event.target.value)} className="mt-1 block w-full rounded-md border border-white/10 bg-[#080d11] px-2.5 py-2 text-sm text-neutral-200">
                    <option value="">All users</option>
                    {users.map((item) => <option key={item.id} value={item.id}>{item.display_name} · {item.email}</option>)}
                  </select>
                </label>
                <label className="text-xs text-neutral-400">
                  Session
                  <select value={sessionFilter} onChange={(event) => setSessionFilter(event.target.value)} className="mt-1 block w-full rounded-md border border-white/10 bg-[#080d11] px-2.5 py-2 text-sm text-neutral-200">
                    <option value="">All sessions</option>
                    {sessions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </label>
                <label className="text-xs text-neutral-400">
                  From
                  <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className="mt-1 block w-full rounded-md border border-white/10 bg-[#080d11] px-2.5 py-2 text-sm text-neutral-200" />
                </label>
                <label className="text-xs text-neutral-400">
                  To
                  <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} className="mt-1 block w-full rounded-md border border-white/10 bg-[#080d11] px-2.5 py-2 text-sm text-neutral-200" />
                </label>
                <label className="text-xs text-neutral-400">
                  Risk level
                  <select value={riskLevel} onChange={(event) => setRiskLevel(event.target.value)} className="mt-1 block w-full rounded-md border border-white/10 bg-[#080d11] px-2.5 py-2 text-sm text-neutral-200">
                    <option value="">All outcomes</option>
                    <option value="allow">Allow</option>
                    <option value="flag">Flag</option>
                    <option value="block">Block</option>
                  </select>
                </label>
                <div className="flex gap-2 self-end">
                  <button
                    type="submit"
                    disabled={auditLoading}
                    className="flex-1 rounded-md bg-emerald-400 px-4 py-2 text-sm font-semibold text-[#03120f] hover:bg-emerald-300 disabled:opacity-60"
                  >
                    {auditLoading ? 'Applying…' : 'Apply'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void resetAuditFilters()}
                    disabled={auditLoading}
                    className="rounded-md border border-white/10 px-3 py-2 text-sm text-neutral-300 hover:bg-white/5 disabled:opacity-60"
                  >
                    Reset
                  </button>
                </div>
              </form>
              {auditLoading ? (
                <p role="status" className="text-sm text-neutral-400">Loading filtered audit entries…</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className={tableClass}>
                    <thead className="text-xs uppercase tracking-wide text-neutral-500">
                      <tr>
                        <th className="pb-3">Timestamp</th>
                        <th className="pb-3">User</th>
                        <th className="pb-3">Session</th>
                        <th className="pb-3">Outcome</th>
                        <th className="pb-3">Risk score</th>
                        <th className="pb-3">Audit reference</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.06]">
                      {audit.map((item) => (
                        <tr key={item.id}>
                          <td className="py-3 text-neutral-400">{formatDate(item.created_at)}</td>
                          <td className="py-3">
                            {item.user_name ?? 'Not captured'}
                            {item.user_email && <span className="block text-xs text-neutral-500">{item.user_email}</span>}
                          </td>
                          <td className="py-3">{item.session_name ?? 'Not captured'}</td>
                          <td className="py-3">{item.risk_decision ?? item.action}</td>
                          <td className="py-3">{item.risk_score ?? '—'}</td>
                          <td className="py-3 text-xs text-neutral-500">#{item.id} · {item.entity_type}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {!auditLoading && audit.length === 0 && <p className="py-4 text-sm text-neutral-500">No audit entries match these filters.</p>}
            </section>
          )}

          {showUsers && (
            <section className={cardClass}>
              <div className="mb-4">
                <h2 className="text-lg font-semibold">User directory</h2>
                <p className="mt-1 text-xs text-neutral-500">Read-only account identity and database-assigned roles.</p>
              </div>
              <div className="overflow-x-auto">
                <table className={tableClass}>
                  <thead className="text-xs uppercase tracking-wide text-neutral-500">
                    <tr>
                      <th className="pb-3">User</th>
                      <th className="pb-3">Roles</th>
                      <th className="pb-3">Created</th>
                      <th className="pb-3">Account status</th>
                      <th className="pb-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06]">
                    {users.map((item) => (
                      <tr key={item.id}>
                        <td className="py-3">
                          <span className="block text-neutral-200">{item.display_name}</span>
                          <span className="text-xs text-neutral-500">{item.email}</span>
                        </td>
                        <td className="py-3">{item.roles.length ? item.roles.join(', ') : 'No assigned roles'}</td>
                        <td className="py-3 text-neutral-400">{formatDate(item.created_at)}</td>
                        <td className="py-3">
                          <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${item.account_status === 'active' ? 'bg-emerald-400/10 text-emerald-300' : item.account_status === 'disabled' ? 'bg-rose-400/10 text-rose-300' : 'bg-neutral-400/10 text-neutral-400'}`}>
                            {item.account_status === 'active' ? 'Active' : item.account_status === 'disabled' ? 'Disabled' : 'Unknown'}
                          </span>
                        </td>
                        <td className="py-3">
                          {item.id === user.id ? (
                            <span className="text-xs text-neutral-500">Current admin</span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setPendingUserStatus({
                                user: item,
                                newStatus: item.account_status === 'disabled' ? 'active' : 'disabled',
                              })}
                              className={`text-xs ${
                                item.account_status === 'disabled'
                                  ? 'text-emerald-300 hover:text-emerald-200'
                                  : 'text-rose-300 hover:text-rose-200'
                              }`}
                            >
                              {item.account_status === 'disabled' ? 'Activate' : 'Disable'}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </section>
  );
}

