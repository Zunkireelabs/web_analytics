import { useEffect, useMemo, useState } from 'react';
import { api, timeAgo } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';
import ClientDrawer from '../components/ClientDrawer.jsx';
import {
  Building, Globe, Clock, GitBranch, Mail, Lock, Plus, Search, Filter,
  ChevronRight, Users as UsersIcon, Activity, Bot,
} from 'lucide-react';

const inputCls = 'w-full text-base sm:text-xs border border-slate-200/80 rounded-xl px-3.5 py-2.5 bg-slate-50/50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#6C63FF]/10 focus:border-[#6C63FF] transition duration-150 font-medium text-slate-800 placeholder:text-slate-400';
const labelCls = 'block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5';

function Field({ label, hint, icon: Icon, ...props }) {
  return (
    <label className="block">
      <span className={labelCls}>{label}</span>
      <div className="relative">
        {Icon && (
          <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
            <Icon size={14} />
          </span>
        )}
        <input className={`${inputCls} ${Icon ? 'pl-10' : ''}`} {...props} />
      </div>
      {hint && <span className="block text-[9.5px] font-semibold text-slate-400 mt-1">{hint}</span>}
    </label>
  );
}

function NewClientForm({ onCreated }) {
  const [name, setName] = useState('');
  const [websiteDomain, setWebsiteDomain] = useState('');
  const [timezone, setTimezone] = useState('Asia/Kolkata');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [state, setState] = useState('idle');
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setState('running');
    setError(null);
    try {
      const site = await api.clients.create({ name, websiteDomain, timezone, email, password });
      setState('idle');
      setName(''); setWebsiteDomain(''); setEmail(''); setPassword('');
      onCreated(site);
    } catch (err) {
      setError(err.message || 'Could not create client.');
      setState('error');
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Client Corporate Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Corp" required icon={Building} />
        <Field label="Website Domain" value={websiteDomain} onChange={(e) => setWebsiteDomain(e.target.value)} placeholder="acme.com" icon={Globe} />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Asia/Kolkata" icon={Clock} />
        <div />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Client Admin Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="client@acme.com" required icon={Mail} />
        <Field label="Admin Account Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" required minLength={8} icon={Lock} />
      </div>
      {state === 'error' && (
        <div className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2">{error}</div>
      )}
      <button type="submit" disabled={state === 'running'}
        className="w-full text-[10px] font-black uppercase tracking-wider px-5 py-3 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] disabled:opacity-60 shadow-md shadow-indigo-500/10 hover:shadow-indigo-500/20"
        style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>
        {state === 'running' ? 'Creating site profile…' : 'Create Client Site'}
      </button>
    </form>
  );
}

const STATUS_PILLS = {
  connected: { label: 'Active baseline', className: 'bg-emerald-50 text-emerald-700 border-emerald-100' },
  baselinePending: { label: 'Baseline pending', className: 'bg-amber-50 text-amber-700 border-amber-100' },
  pending: { label: 'Awaiting integrations', className: 'bg-amber-50 text-amber-700 border-amber-100' },
};
const LIFECYCLE_PILLS = {
  suspended: { label: 'Suspended', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  soft_deleted: { label: 'Soft-deleted', className: 'bg-rose-50 text-rose-700 border-rose-200' },
};

const FILTERS = [
  { value: 'all', label: 'All statuses' },
  { value: 'connected', label: 'Active baseline' },
  { value: 'baselinePending', label: 'Baseline pending' },
  { value: 'pending', label: 'Awaiting integrations' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'soft_deleted', label: 'Soft-deleted' },
];

function onboardingStatus(c) {
  return !c.connected ? 'pending' : c.baselined ? 'connected' : 'baselinePending';
}

function KpiCard({ label, value, icon: Icon }) {
  return (
    <div className="bg-white/70 border border-slate-200/50 backdrop-blur-md shadow-sm rounded-2xl p-4 flex items-center gap-3">
      <div className="w-9 h-9 rounded-xl bg-indigo-50 border border-indigo-100 grid place-items-center text-[#6C63FF] shrink-0">
        <Icon size={15} />
      </div>
      <div className="min-w-0">
        <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 truncate">{label}</p>
        <p className="text-lg font-black text-slate-900 leading-tight">{value}</p>
      </div>
    </div>
  );
}

export default function ClientOnboarding() {
  const [clients, setClients] = useState(null); // null = loading
  const [requests, setRequests] = useState(null); // null = loading
  const [users, setUsers] = useState([]); // for deriving each client's Owner

  const [reviewState, setReviewState] = useState({}); // {[requestId]: 'approving'|'rejecting'|'error'}
  const [reviewError, setReviewError] = useState({});

  const [showNewForm, setShowNewForm] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });

  const [selectedClientId, setSelectedClientId] = useState(null);
  const [drawerInitialTab, setDrawerInitialTab] = useState('general');

  const load = () => api.clients.list().then(setClients).catch(() => setClients([]));
  const loadRequests = () => api.clients.signupRequests.list().then(setRequests).catch(() => setRequests([]));
  const loadUsers = () => api.adminUsers.list().then(setUsers).catch(() => setUsers([]));

  useEffect(() => { load(); loadRequests(); loadUsers(); }, []);

  const approveRequest = async (request) => {
    setReviewState((s) => ({ ...s, [request.id]: 'approving' }));
    setReviewError((e) => ({ ...e, [request.id]: null }));
    try {
      const site = await api.clients.signupRequests.approve(request.id);
      setRequests((rs) => (rs || []).filter((r) => r.id !== request.id));
      onCreated(site);
    } catch (err) {
      setReviewError((e) => ({ ...e, [request.id]: err.message || 'Approval failed.' }));
      setReviewState((s) => ({ ...s, [request.id]: 'error' }));
    }
  };

  const rejectRequest = async (request) => {
    setReviewState((s) => ({ ...s, [request.id]: 'rejecting' }));
    setReviewError((e) => ({ ...e, [request.id]: null }));
    try {
      await api.clients.signupRequests.reject(request.id);
      setRequests((rs) => (rs || []).filter((r) => r.id !== request.id));
    } catch (err) {
      setReviewError((e) => ({ ...e, [request.id]: err.message || 'Reject failed.' }));
      setReviewState((s) => ({ ...s, [request.id]: 'error' }));
    }
  };

  const onCreated = (site) => {
    setShowNewForm(false);
    load();
    loadUsers();
    setSelectedClientId(site.id);
    setDrawerInitialTab('integrations');
  };

  const ownerFor = (clientId) => {
    const siteUsers = users.filter((u) => u.site_id === clientId);
    return siteUsers.find((u) => u.role === 'tenant_admin') || siteUsers[0] || null;
  };

  const filtered = useMemo(() => {
    if (!clients) return [];
    const q = search.trim().toLowerCase();
    let rows = clients.filter((c) => {
      if (q && !(c.name.toLowerCase().includes(q) || (c.websiteDomain || '').toLowerCase().includes(q))) return false;
      if (statusFilter === 'all') return true;
      if (statusFilter === 'suspended' || statusFilter === 'soft_deleted') return c.status === statusFilter;
      return onboardingStatus(c) === statusFilter;
    });
    rows = [...rows].sort((a, b) => {
      let av, bv;
      if (sort.key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (sort.key === 'status') { av = onboardingStatus(a); bv = onboardingStatus(b); }
      else if (sort.key === 'oauth') { av = a.oauthMaxPermissionLevel || ''; bv = b.oauthMaxPermissionLevel || ''; }
      else { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      if (av < bv) return sort.dir === 'asc' ? -1 : 1;
      if (av > bv) return sort.dir === 'asc' ? 1 : -1;
      return 0;
    });
    return rows;
  }, [clients, search, statusFilter, sort]);

  const toggleSort = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  const kpis = useMemo(() => {
    const list = clients || [];
    return {
      total: list.length,
      pendingRegistrations: (requests || []).length,
      reposConnected: list.filter((c) => c.repoConnected).length,
      autonomous: list.filter((c) => c.autoRemediationEnabled).length,
      awaitingIntegrations: list.filter((c) => !c.connected).length,
      activeBaselines: list.filter((c) => c.baselined).length,
    };
  }, [clients, requests]);

  const selectedClient = clients?.find((c) => c.id === selectedClientId) || null;

  const openDrawer = (client, initialTab = 'general') => {
    setSelectedClientId(client.id);
    setDrawerInitialTab(initialTab);
  };

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden no-print">
        <div className="absolute top-0 right-1/3 w-[550px] h-[550px] rounded-full blur-[140px] bg-indigo-500/5 opacity-30 pulse-glow" />
      </div>

      <PageHeader
        title="Clients"
        icon="🏢"
        subtitle="Manage client workspaces, integrations and AI configuration."
        right={
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <div className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-100/80 px-2.5 py-2">
              <Search size={12} className="text-slate-400 shrink-0" />
              <input
                value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search clients…"
                className="bg-transparent text-xs font-semibold text-slate-700 placeholder:text-slate-400 focus:outline-none w-36"
              />
            </div>
            <div className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-100/80 px-2.5 py-2">
              <Filter size={12} className="text-slate-400 shrink-0" />
              <select
                value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
                className="bg-transparent text-xs font-semibold text-slate-700 focus:outline-none"
              >
                {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </div>
            <button type="button" onClick={() => setShowNewForm(true)}
              className="text-[10px] font-black uppercase tracking-wider px-4.5 py-2.5 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] shadow-md shadow-indigo-500/10 hover:shadow-indigo-500/20 flex items-center gap-1.5"
              style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>
              <Plus size={12} strokeWidth={2.5} />
              <span>New Client</span>
            </button>
          </div>
        }
      />

      {/* Top summary */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard label="Registered Clients" value={kpis.total} icon={Building} />
        <KpiCard label="Pending Registrations" value={kpis.pendingRegistrations} icon={UsersIcon} />
        <KpiCard label="Connected Repositories" value={kpis.reposConnected} icon={GitBranch} />
        {/* Distinct from Connected Repositories on purpose — a repo is the
            capability, this is how many sites actually act on it unattended. */}
        <KpiCard label="Autonomous Sites" value={kpis.autonomous} icon={Bot} />
        <KpiCard label="Awaiting Integrations" value={kpis.awaitingIntegrations} icon={Clock} />
        <KpiCard label="Active Baselines" value={kpis.activeBaselines} icon={Activity} />
      </div>

      {/* Pending registrations — compact queue */}
      <div className="bg-white/70 border border-slate-200/50 backdrop-blur-md shadow-sm rounded-2xl p-5">
        <div className="flex items-center justify-between gap-3 mb-2">
          <h3 className="text-xs font-black uppercase tracking-widest text-slate-400">Pending Registrations</h3>
          {requests && requests.length > 0 && (
            <span className="text-[9px] font-black uppercase tracking-wider bg-indigo-50 border border-indigo-100/50 text-indigo-600 px-2.5 py-0.5 rounded-full">
              {requests.length} pending
            </span>
          )}
        </div>

        {requests === null ? (
          <p className="text-xs text-slate-400 font-semibold py-2">Loading…</p>
        ) : requests.length === 0 ? (
          <p className="text-xs text-slate-400 font-semibold py-2">No pending registrations.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {requests.map((r) => {
              const state = reviewState[r.id];
              const busy = state === 'approving' || state === 'rejecting';
              return (
                <div key={r.id} className="py-2.5 flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold text-slate-800 truncate">{r.companyName}</p>
                    <p className="text-[10px] text-slate-400 font-semibold truncate">
                      {r.contactEmail} {r.websiteDomain && `· ${r.websiteDomain}`} · requested {timeAgo(r.createdAt)}
                    </p>
                    {reviewError[r.id] && <p className="text-[10px] font-semibold text-rose-600 mt-0.5">{reviewError[r.id]}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button type="button" onClick={() => approveRequest(r)} disabled={busy}
                      className="text-[9.5px] font-black uppercase tracking-wider px-3 py-2 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-700 transition disabled:opacity-60">
                      {state === 'approving' ? 'Approve…' : 'Approve'}
                    </button>
                    <button type="button" onClick={() => rejectRequest(r)} disabled={busy}
                      className="text-[9.5px] font-black uppercase tracking-wider px-3 py-2 rounded-lg bg-slate-50 hover:bg-slate-100 text-slate-500 transition disabled:opacity-60">
                      {state === 'rejecting' ? 'Reject…' : 'Reject'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Main content — data table */}
      <div className="bg-white/70 border border-slate-200/50 backdrop-blur-md shadow-sm rounded-2xl overflow-hidden">
        {clients === null ? (
          <p className="text-xs text-slate-400 font-semibold p-6">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="text-xs text-slate-400 font-semibold p-6">
            {clients.length === 0 ? 'No registered client sites on record.' : 'No clients match your search/filter.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-100">
                  {[
                    { key: 'name', label: 'Client' },
                    { key: 'status', label: 'Status' },
                    { key: null, label: 'Repository' },
                    { key: 'oauth', label: 'OAuth' },
                    { key: null, label: '' },
                  ].map((col) => (
                    <th key={col.label || 'actions'}
                      onClick={col.key ? () => toggleSort(col.key) : undefined}
                      className={`px-4 py-3 text-[9px] font-black uppercase tracking-widest text-slate-400 ${col.key ? 'cursor-pointer select-none hover:text-slate-600' : ''}`}>
                      {col.label}{col.key && sort.key === col.key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => {
                  const s = STATUS_PILLS[onboardingStatus(c)];
                  const oauthLabel = { read_only: 'Read Only', ai_actions: 'AI Actions', automation: 'Automation' }[c.oauthMaxPermissionLevel] || 'Read Only';
                  return (
                    <tr key={c.id} onClick={() => openDrawer(c)}
                      className="border-b border-slate-50 last:border-b-0 hover:bg-slate-50/70 transition cursor-pointer" style={{ height: '60px' }}>
                      <td className="px-4 py-2">
                        <p className="text-xs font-bold text-slate-800 truncate">{c.name}</p>
                        <p className="text-[10px] font-mono text-slate-400 truncate">{c.websiteDomain || 'no domain configured'}</p>
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {LIFECYCLE_PILLS[c.status] && (
                            <span className={`text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded border ${LIFECYCLE_PILLS[c.status].className}`}>
                              {LIFECYCLE_PILLS[c.status].label}
                            </span>
                          )}
                          <span className={`text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded border ${s.className}`}>{s.label}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        {/* Repo AND autonomy together: a connected repo only
                            means this site CAN receive PRs, not that anything
                            is actually acting on its own. Without the second
                            badge the list reads as "wired up" for a site whose
                            agents ship nothing unattended. */}
                        <div className="flex items-center gap-1 flex-wrap">
                          {c.repoConnected ? (
                            <span className="text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 bg-slate-50 flex items-center gap-1 w-fit">
                              <GitBranch size={9} /> Connected
                            </span>
                          ) : (
                            <span className="text-[10px] font-semibold text-slate-300">Not connected</span>
                          )}
                          {c.autoRemediationEnabled && (
                            <span
                              title={`Ships up to ${c.autoRemediationDailyLimit ?? 30} safe fixes a day as pull requests, unattended`}
                              className="text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded border border-emerald-200 text-emerald-700 bg-emerald-50 flex items-center gap-1 w-fit"
                            >
                              <Bot size={9} /> Auto
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <span className="text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-500">{oauthLabel}</span>
                      </td>
                      <td className="px-4 py-2 text-right">
                        <ChevronRight size={14} className="text-slate-300 inline-block" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal isOpen={showNewForm} onClose={() => setShowNewForm(false)} title="New Client" subtitle="Creates target login profile and initial workspace configuration." icon={Plus} maxWidth="max-w-xl">
        <NewClientForm onCreated={onCreated} />
      </Modal>

      <ClientDrawer
        client={selectedClient}
        owner={selectedClient ? ownerFor(selectedClient.id) : null}
        isOpen={!!selectedClient}
        onClose={() => setSelectedClientId(null)}
        onReload={() => { load(); loadUsers(); }}
        initialTab={drawerInitialTab}
      />
    </div>
  );
}
