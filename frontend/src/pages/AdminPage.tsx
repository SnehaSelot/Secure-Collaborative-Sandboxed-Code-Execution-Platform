import { useCallback, useEffect, useState, type FormEvent } from 'react';
import axios from 'axios';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { apiClient } from '../api/client';
import { useAuthStore } from '../state/authStore';

interface AdminOverview {
  active_sessions: number;
  recent_sessions: number;
  recent_executions: number;
  execution_failures: number;
  flagged_execution_events: number;
}
interface AdminSession {
  id: string; name: string; status: string; created_at: string; last_active_at: string;
  owner_name: string; owner_email: string; active_participants: number;
}
interface AdminExecution {
  id: string; session_name: string | null; file_path: string | null; user_name: string;
  user_email: string; language: string; status: string; exit_code: number | null;
  created_at: string; risk_score: number | null; risk_decision: string | null;
}
interface AdminAudit {
  id: number; created_at: string; user_id: string | null; user_name: string | null;
  user_email: string | null; session_id: string | null; session_name: string | null;
  action: string; entity_type: string; entity_id: string; metadata: Record<string, unknown> | null;
  risk_score: number | null; risk_decision: string | null;
}
interface FlaggedEvent extends AdminAudit {
  metadata: { language?: string; code_sha256?: string; code_chars?: number } | null;
}
interface AdminUser {
  id: string; email: string; display_name: string; created_at: string; roles: string[];
}

const cardClass = 'rounded-xl border border-white/10 bg-neutral-900/60 p-5';
const tableClass = 'w-full min-w-[760px] text-left text-sm';
const headersFor = (token: string) => ({ Authorization: `Bearer ${token}` });
const formatDate = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : '—';

const ADMIN_TABS = [
  { id: 'all', label: 'All Sections', to: '/admin' },
  { id: 'overview', label: 'Overview', to: '/admin' },
  { id: 'sessions', label: 'Session Monitoring', to: '/admin/sessions' },
  { id: 'executions', label: 'Execution History', to: '/admin/executions' },
  { id: 'audit', label: 'Audit Trail', to: '/admin/audit' },
  { id: 'flagged', label: 'Flagged Events', to: '/admin/flagged' },
  { id: 'users', label: 'User Directory', to: '/admin/users' },
] as const;

export function AdminPage() {
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const navigate = useNavigate();
  const { section } = useParams<{ section?: string }>();
  const activeTab = section || 'all';

  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [executions, setExecutions] = useState<AdminExecution[]>([]);
  const [audit, setAudit] = useState<AdminAudit[]>([]);
  const [flagged, setFlagged] = useState<FlaggedEvent[]>([]);
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

  const loadDashboard = useCallback(async () => {
    if (!user) return;
    const config = { headers: headersFor(user.token) };
    try {
      const [overviewResult, sessionResult, executionResult, auditResult, flaggedResult, userResult] = await Promise.all([
        apiClient.get<AdminOverview>('/admin/overview', config),
        apiClient.get<AdminSession[]>('/admin/sessions', config),
        apiClient.get<AdminExecution[]>('/admin/executions', config),
        apiClient.get<AdminAudit[]>('/admin/audit', config),
        apiClient.get<FlaggedEvent[]>('/admin/flagged', config),
        apiClient.get<AdminUser[]>('/admin/users', config),
      ]);
      setOverview(overviewResult.data);
      setSessions(sessionResult.data);
      setExecutions(executionResult.data);
      setAudit(auditResult.data);
      setFlagged(flaggedResult.data);
      setUsers(userResult.data);
    } catch (requestError) {
      if (!handleAuthorizationError(requestError)) setError('The admin dashboard data could not be loaded. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [handleAuthorizationError, user]);

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
    if (startDate) params.set('start_date', `${startDate}T00:00:00`);
    if (endDate) params.set('end_date', `${endDate}T23:59:59`);
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
    executions: {
      title: 'Execution History',
      subtitle: 'Execution history recorded across sandbox runs.',
    },
    flagged: {
      title: 'Flagged Events / Risk Review',
      subtitle: 'Risk score and immutable audit entry for flagged execution attempts.',
    },
    audit: {
      title: 'Audit Trail',
      subtitle: 'Read-only audit entries; this dashboard does not edit or delete them.',
    },
    users: {
      title: 'User Directory',
      subtitle: 'Read-only account identity and database-assigned roles.',
    },
    all: {
      title: 'Admin dashboard',
      subtitle: 'Live views from the existing session and audit records.',
    },
  };
  const headerInfo = pageTitles[activeTab] || pageTitles.all;

  const showOverview = activeTab === 'all' || activeTab === 'overview';
  const showSessions = activeTab === 'all' || activeTab === 'sessions';
  const showExecutions = activeTab === 'all' || activeTab === 'executions';
  const showFlagged = activeTab === 'all' || activeTab === 'flagged';
  const showAudit = activeTab === 'all' || activeTab === 'audit';
  const showUsers = activeTab === 'all' || activeTab === 'users';

  return (
    <section className="mx-auto w-full max-w-[1440px] space-y-7 p-5 sm:p-8">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300">GlassHouse Administration</p>
        <h1 className="mt-2 text-2xl font-semibold">{headerInfo.title}</h1>
        <p className="mt-1 text-sm text-neutral-500">{headerInfo.subtitle}</p>
      </header>

      {/* Navigation tabs for quick switching between admin views */}
      <nav aria-label="Admin views" className="flex flex-wrap items-center gap-2 border-b border-white/10 pb-4">
        {ADMIN_TABS.map((tab) => {
          const isActive = (tab.id === 'all' && !section) || activeTab === tab.id;
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

      {loading ? (
        <p role="status" className="text-sm text-neutral-400">Loading admin data…</p>
      ) : overview && (
        <>
          {showOverview && (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
              {[
                ['Active sessions', overview.active_sessions],
                ['Recent sessions · 7 days', overview.recent_sessions],
                ['Recent executions · 7 days', overview.recent_executions],
                ['Execution failures', overview.execution_failures],
                ['Flagged execution events', overview.flagged_execution_events],
              ].map(([label, value]) => (
                <article key={label} className={cardClass}>
                  <p className="text-sm text-neutral-500">{label}</p>
                  <p className="mt-2 text-3xl font-semibold text-neutral-100">{value}</p>
                </article>
              ))}
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
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {sessions.length === 0 && <p className="py-4 text-sm text-neutral-500">No collaboration sessions are recorded.</p>}
            </section>
          )}

          {showExecutions && (
            <section className={cardClass}>
              <div className="mb-4">
                <h2 className="text-lg font-semibold">Recent executions</h2>
                <p className="mt-1 text-xs text-neutral-500">Execution history is shown when a record exists in the executions table.</p>
              </div>
              <div className="overflow-x-auto">
                <table className={tableClass}>
                  <thead className="text-xs uppercase tracking-wide text-neutral-500">
                    <tr>
                      <th className="pb-3">Time</th>
                      <th className="pb-3">User</th>
                      <th className="pb-3">Session / file</th>
                      <th className="pb-3">Language</th>
                      <th className="pb-3">Status</th>
                      <th className="pb-3">Exit</th>
                      <th className="pb-3">Risk</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06]">
                    {executions.map((item) => (
                      <tr key={item.id}>
                        <td className="py-3 text-neutral-400">{formatDate(item.created_at)}</td>
                        <td className="py-3">{item.user_name}</td>
                        <td className="py-3">{item.session_name ?? '—'}{item.file_path ? ` / ${item.file_path}` : ''}</td>
                        <td className="py-3">{item.language}</td>
                        <td className="py-3 capitalize">{item.status}</td>
                        <td className="py-3">{item.exit_code ?? '—'}</td>
                        <td className="py-3">{item.risk_score == null ? '—' : `${item.risk_score} · ${item.risk_decision}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {executions.length === 0 && (
                <p className="py-4 text-sm text-neutral-500">No execution records are available. The current run endpoints do not persist execution rows.</p>
              )}
            </section>
          )}

          {showFlagged && (
            <section className={cardClass}>
              <div className="mb-4">
                <h2 className="text-lg font-semibold">Flagged execution details</h2>
                <p className="mt-1 text-xs text-neutral-500">Risk score and immutable audit entry for flagged execution attempts.</p>
              </div>
              {flagged.length === 0 ? (
                <p className="text-sm text-neutral-500">No flagged execution events are recorded.</p>
              ) : (
                <div className="space-y-3">
                  {flagged.map((item) => (
                    <article key={item.id} className="rounded-lg border border-amber-300/15 bg-amber-300/[0.035] p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="font-medium text-amber-100">Flagged execution · {item.metadata?.language ?? 'language unavailable'}</p>
                          <p className="mt-1 text-xs text-neutral-400">{formatDate(item.created_at)} · {item.user_name ?? 'User not captured'} · {item.session_name ?? 'Session not captured'}</p>
                        </div>
                        <span className="rounded-full border border-amber-300/20 px-2.5 py-1 text-xs text-amber-100">
                          Risk score {item.risk_score ?? 'unavailable'}
                        </span>
                      </div>
                      <p className="mt-3 break-all text-xs text-neutral-500">Audit entry #{item.id} · source fingerprint {item.metadata?.code_sha256 ?? 'unavailable'}</p>
                      <p className="mt-2 text-xs text-neutral-500">Submitted source code is not retained in the risk audit record.</p>
                    </article>
                  ))}
                </div>
              )}
            </section>
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
                <button disabled={auditLoading} className="self-end rounded-md bg-emerald-400 px-4 py-2 text-sm font-semibold text-[#03120f] disabled:opacity-60">
                  {auditLoading ? 'Applying…' : 'Apply filters'}
                </button>
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
                        <td className="py-3 text-neutral-500">Not tracked by backend</td>
                        <td className="py-3 text-neutral-600">Account disabling unavailable</td>
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

