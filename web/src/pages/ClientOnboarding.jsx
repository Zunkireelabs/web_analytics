import { useEffect, useMemo, useState } from 'react';
import { api, timeAgo } from '../api.js';
import PageToolbar from '../components/PageToolbar.jsx';
import PageIntro from '../components/layout/PageIntro.jsx';
import KpiStrip from '../components/layout/KpiStrip.jsx';
import { Tray, TrayCard } from '../components/layout/Tray.jsx';
import Badge from '../components/Badge.jsx';
import Button from '../components/Button.jsx';
import Field from '../components/Field.jsx';
import Select from '../components/Select.jsx';
import Modal from '../components/Modal.jsx';
import ClientDrawer from '../components/ClientDrawer.jsx';
import AddProjectModal from '../components/AddProjectModal.jsx';
import { Plus, Search, GitBranch, Bot, ChevronRight, FolderPlus, Globe, Package, Check, Eye, EyeOff, Wand2 } from 'lucide-react';

// Universal Product Growth mode: an onboarded property is either a
// content/traffic 'website' or a zero-traffic 'product' (see
// server/lib/site-capabilities.js) — generic across any product tenant,
// never a Zenly-specific choice. Defaults to 'website' so every existing
// onboarding flow is unaffected unless staff explicitly pick Product.
const PROPERTY_TYPES = [
  { value: 'website', label: 'Website', icon: Globe, blurb: 'Has organic traffic', hint: 'Gets full search analytics and the site-improvement agents.' },
  { value: 'product', label: 'Product', icon: Package, blurb: 'SaaS or product site', hint: 'Zero or low traffic. Visibility and demand-generation agents only; no GSC/GA4 needed.' },
];

const inputRing = { boxShadow: '0 0 0 1px var(--input)' };

// Every zone the browser knows, so staff pick a real IANA name instead of typing
// one. The default is always present even on a browser without the API.
const TIMEZONES = (() => {
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { /* older browser: fall back below */ }
  return zones.includes('Asia/Kolkata') ? zones : ['Asia/Kolkata', ...zones];
})();

const randomPassword = () => {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint32Array(14));
  return Array.from(bytes, (n) => chars[n % chars.length]).join('');
};

function FormSection({ step, title, hint, children }) {
  return (
    <section className="space-y-3">
      <div className="flex items-start gap-2.5">
        <span className="grid place-items-center size-5 rounded-full bg-muted text-[11px] font-medium text-text mt-px shrink-0">{step}</span>
        <div>
          <h3 className="text-[13px] font-medium text-fg leading-5">{title}</h3>
          {hint && <p className="text-xs text-faint">{hint}</p>}
        </div>
      </div>
      <div className="space-y-4 md:pl-[30px]">{children}</div>
    </section>
  );
}

// 0-4: length, mixed case, a digit, and a long password each add a bar.
const passwordStrength = (pw) => {
  if (!pw) return 0;
  let n = 0;
  if (pw.length >= 8) n++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) n++;
  if (/\d/.test(pw)) n++;
  if (pw.length >= 12) n++;
  return n;
};
const STRENGTH_LABELS = ['', 'Weak', 'Okay', 'Good', 'Strong'];

function NewClientForm({ onCreated, onCancel }) {
  const [name, setName] = useState('');
  const [websiteDomain, setWebsiteDomain] = useState('');
  const [timezone, setTimezone] = useState('Asia/Kolkata');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [propertyType, setPropertyType] = useState('website');
  const [state, setState] = useState('idle');
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setState('running');
    setError(null);
    try {
      const site = await api.clients.create({ name, websiteDomain, timezone, email, password, propertyType });
      setState('idle');
      setName(''); setWebsiteDomain(''); setEmail(''); setPassword(''); setShowPassword(false); setPropertyType('website');
      onCreated(site);
    } catch (err) {
      setError(err.message || 'Could not create client.');
      setState('error');
    }
  };

  const type = PROPERTY_TYPES.find((t) => t.value === propertyType);

  const strength = passwordStrength(password);

  return (
    <form onSubmit={submit} className="space-y-6">
      <FormSection step="1" title="What are you adding?">
        <div className="grid grid-cols-2 gap-2.5">
          {PROPERTY_TYPES.map((t) => {
            const on = propertyType === t.value;
            const Icon = t.icon;
            return (
              <button key={t.value} type="button" onClick={() => setPropertyType(t.value)} aria-pressed={on}
                className={`relative flex items-center gap-3 rounded-control px-3.5 py-3 text-left transition ${on ? 'bg-primary-tint' : 'bg-white hover:bg-muted'}`}
                style={{ boxShadow: on ? '0 0 0 1px var(--primary), 0 0 0 4px var(--primary-tint)' : 'var(--ring)' }}>
                <span className={`grid place-items-center size-8 rounded-[8px] shrink-0 transition ${on ? 'bg-primary text-white' : 'bg-muted text-text'}`}>
                  <Icon size={15} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-fg">{t.label}</span>
                  <span className="block text-xs text-faint truncate">{t.blurb}</span>
                </span>
                {on && <Check size={14} className="absolute top-2.5 right-2.5 text-primary" aria-hidden />}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-faint -mt-1">{type.hint}</p>
      </FormSection>

      <FormSection step="2" title="Business details">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Client name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Corp" required autoFocus />
          <Field label={propertyType === 'product' ? 'Product website (optional)' : 'Website domain'} value={websiteDomain}
            onChange={(e) => setWebsiteDomain(e.target.value)} placeholder="acme.com" />
        </div>
        <Select label="Timezone" hint="Used for report schedules and daily jobs." value={timezone} onChange={(e) => setTimezone(e.target.value)}>
          {TIMEZONES.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
        </Select>
      </FormSection>

      <FormSection step="3" title="Admin login" hint="The client signs in with this to see their own workspace.">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Admin email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="client@acme.com" required />
          <div className="fld">
            <label htmlFor="new-client-password" className="fld__label">Password</label>
            <div className="relative fld">
              <input id="new-client-password" type={showPassword ? 'text' : 'password'} value={password}
                onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" required minLength={8}
                autoComplete="new-password" className="!pr-16" />
              <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center">
                <button type="button" title={showPassword ? 'Hide password' : 'Show password'} aria-label={showPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowPassword((v) => !v)}
                  className="grid place-items-center size-7 rounded-control text-faint hover:text-fg hover:bg-muted transition">
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button type="button" title="Generate a strong password" aria-label="Generate a strong password"
                  onClick={() => { setPassword(randomPassword()); setShowPassword(true); }}
                  className="grid place-items-center size-7 rounded-control text-faint hover:text-primary hover:bg-primary-tint transition">
                  <Wand2 size={14} />
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2 h-4" aria-live="polite">
              <div className="flex gap-1 flex-1" aria-hidden>
                {[1, 2, 3, 4].map((i) => (
                  <span key={i} className={`h-1 flex-1 rounded-full transition-colors ${i <= strength ? (strength < 3 ? 'bg-[#e0a100]' : 'bg-[#2f9e5b]') : 'bg-border'}`} />
                ))}
              </div>
              <span className="text-xs text-faint w-12 text-right">{STRENGTH_LABELS[strength]}</span>
            </div>
          </div>
        </div>
      </FormSection>

      {state === 'error' && error && (
        <div className="rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2">{error}</div>
      )}

      <div className="flex items-center justify-between gap-3 pt-4 border-t border-border">
        <p className="text-xs text-faint hidden sm:block">A workspace is created for this client automatically.</p>
        <div className="flex items-center gap-2 ml-auto">
          <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={state === 'running'}>
            {state === 'running' ? 'Creating…' : 'Create client'}
          </Button>
        </div>
      </div>
    </form>
  );
}

const STATUS_PILLS = {
  connected: { label: 'Active baseline', tone: 'green' },
  baselinePending: { label: 'Baseline pending', tone: 'amber' },
  pending: { label: 'Awaiting integrations', tone: 'amber' },
};
const LIFECYCLE_PILLS = {
  suspended: { label: 'Suspended', tone: 'amber' },
  soft_deleted: { label: 'Soft-deleted', tone: 'red' },
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

// Setup steps a project works through. A suspended/deleted project, or one that
// has not finished these, "needs attention" and floats to the top of its card.
const setupSteps = (c) => [
  { label: 'Integrations', done: !!c.connected },
  { label: 'Baseline', done: !!c.baselined },
  { label: 'Repository', done: !!c.repoConnected },
];
const needsAttention = (c) => c.status !== 'active' || setupSteps(c).some((s) => !s.done);

function SetupMeter({ client }) {
  const steps = setupSteps(client);
  const done = steps.filter((s) => s.done).length;
  const missing = steps.filter((s) => !s.done).map((s) => s.label).join(', ');
  return (
    <div title={missing ? `Still to do: ${missing}` : 'Setup complete'} className="flex items-center gap-2">
      <div className="flex gap-0.5" aria-hidden>
        {steps.map((s) => (
          <span key={s.label} className={`h-1.5 w-5 rounded-full ${s.done ? 'bg-primary' : 'bg-border'}`} />
        ))}
      </div>
      <span className="text-xs text-faint tabular-nums">{done}/{steps.length}</span>
    </div>
  );
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export default function ClientOnboarding() {
  const [clients, setClients] = useState(null); // null = loading
  const [requests, setRequests] = useState(null); // null = loading
  const [users, setUsers] = useState([]); // for deriving each client's Owner
  const [workspaces, setWorkspaces] = useState([]); // real workspaces (a platform admin sees all)
  const [addFor, setAddFor] = useState(null); // workspace the Add project modal is open for

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
  const loadWorkspaces = () => api.workspaces().then((r) => setWorkspaces(r.workspaces || [])).catch(() => setWorkspaces([]));

  useEffect(() => { load(); loadRequests(); loadUsers(); loadWorkspaces(); }, []);

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
    loadWorkspaces();
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
      if (sort.key === 'name') {
        const d = Number(needsAttention(b)) - Number(needsAttention(a));
        if (d) return d;
      }
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

  // One card per workspace, holding that workspace's (filtered, sorted) client
  // rows. A site that has no workspace yet is shown as its own card so nothing
  // disappears from the list.
  const groups = useMemo(() => {
    const byId = new Map(workspaces.map((w) => [w.id, w]));
    const map = new Map();
    for (const c of filtered) {
      const key = c.workspaceId ?? `solo-${c.id}`;
      if (!map.has(key)) map.set(key, { key, workspace: byId.get(c.workspaceId) || null, clients: [] });
      map.get(key).clients.push(c);
    }
    return [...map.values()]
      .map((g) => ({ ...g, name: g.workspace?.name || g.clients[0].name, attention: g.clients.filter(needsAttention).length }))
      .sort((a, b) => (b.attention - a.attention) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }, [filtered, workspaces]);

  // Switch into the workspace's first project, then land on its dashboard. A
  // full navigation, so every page loads fresh for that project.
  const openWorkspace = async (group) => {
    await api.switchProject(group.clients[0].id).catch(() => {});
    window.location.assign('/overview');
  };

  const kpis = useMemo(() => {
    const list = clients || [];
    return [
      { label: 'Registered clients', value: list.length },
      { label: 'Pending registrations', value: (requests || []).length },
      { label: 'Connected repositories', value: list.filter((c) => c.repoConnected).length },
      // Distinct from Connected Repositories on purpose — a repo is the
      // capability, this is how many sites actually act on it unattended.
      { label: 'Autonomous sites', value: list.filter((c) => c.autoRemediationEnabled).length },
      { label: 'Need attention', value: list.filter(needsAttention).length },
      { label: 'Active baselines', value: list.filter((c) => c.baselined).length },
    ];
  }, [clients, requests]);

  const selectedClient = clients?.find((c) => c.id === selectedClientId) || null;

  const openDrawer = (client, initialTab = 'general') => {
    setSelectedClientId(client.id);
    setDrawerInitialTab(initialTab);
  };

  const columns = [
    { key: 'name', label: 'Project', cls: 'w-[52%] lg:w-[28%]' },
    { key: 'status', label: 'Status', cls: 'w-[38%] lg:w-[20%]' },
    { key: null, label: 'Setup', cls: 'hidden lg:table-cell lg:w-[16%]' },
    { key: null, label: 'Repository', cls: 'hidden lg:table-cell lg:w-[22%]' },
    { key: 'oauth', label: 'OAuth', cls: 'hidden lg:table-cell lg:w-[10%]' },
    { key: null, label: '', cls: 'w-10' },
  ];

  return (
    <div className="max-w-[1360px] mx-auto px-4 md:px-6 pt-6 pb-12 fade-up">
      <PageToolbar>
        <div className="relative basis-full md:basis-auto md:flex-none">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <input type="text" placeholder="Search clients…" aria-label="Search clients" value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-full md:w-56 pl-8 pr-3 rounded-control bg-white text-[13px] text-fg outline-none" style={inputRing} />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status"
          className="h-8 rounded-control bg-white text-[13px] text-fg px-2.5 outline-none" style={inputRing}>
          {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
        <Button variant="primary" className="md:ml-auto" onClick={() => setShowNewForm(true)}>
          <Plus size={14} />New client
        </Button>
      </PageToolbar>

      <PageIntro title="Clients" subtitle="Manage client workspaces, integrations and AI configuration." />

      <KpiStrip items={kpis} cols={6} loading={clients === null && requests === null} />

      <Tray className="mt-3">
        <TrayCard title="Pending registrations"
          action={requests && requests.length > 0 ? <Badge tone="primary">{requests.length} pending</Badge> : null}>
          {requests === null ? (
            <p className="px-5 pb-4 text-[13px] text-faint">Loading…</p>
          ) : requests.length === 0 ? (
            <p className="px-5 pb-4 text-[13px] text-faint">No pending registrations.</p>
          ) : (
            <div className="border-t border-border">
              {requests.map((r) => {
                const state = reviewState[r.id];
                const busy = state === 'approving' || state === 'rejecting';
                return (
                  <div key={r.id} className="px-5 py-3 border-b border-border last:border-0 flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium text-fg truncate">{r.companyName}</p>
                      <p className="text-xs text-faint truncate">
                        {r.contactEmail} {r.websiteDomain && `· ${r.websiteDomain}`} · requested {timeAgo(r.createdAt)}
                      </p>
                      {reviewError[r.id] && <p className="text-xs text-[#b42318] mt-0.5">{reviewError[r.id]}</p>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button variant="primary" onClick={() => approveRequest(r)} disabled={busy}>
                        {state === 'approving' ? 'Approving…' : 'Approve'}
                      </Button>
                      <Button variant="light" onClick={() => rejectRequest(r)} disabled={busy}>
                        {state === 'rejecting' ? 'Rejecting…' : 'Reject'}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </TrayCard>
      </Tray>

      {/* One card per workspace */}
      {clients === null ? (
        <Tray className="mt-3"><TrayCard><p className="px-5 py-4 text-[13px] text-faint">Loading…</p></TrayCard></Tray>
      ) : groups.length === 0 ? (
        <Tray className="mt-3">
          <TrayCard>
            <p className="px-5 py-4 text-[13px] text-faint">
              {clients.length === 0 ? 'No registered client sites on record.' : 'No clients match your search/filter.'}
            </p>
          </TrayCard>
        </Tray>
      ) : groups.map((g) => {
        const projectCount = g.workspace ? g.workspace.projects.length : g.clients.length;
        const memberCount = g.workspace?.memberCount ?? 0;
        return (
          <Tray key={g.key} className="mt-3">
            <TrayCard title={g.name}
              subtitle={g.workspace ? `${plural(projectCount, 'project', 'projects')} · ${plural(memberCount, 'member', 'members')}` : plural(projectCount, 'project', 'projects')}
              action={(
                <div className="flex items-center gap-2">
                  {g.attention > 0 && <span className="hidden sm:inline-flex"><Badge tone="amber">{g.attention} need{g.attention === 1 ? 's' : ''} attention</Badge></span>}
                  {g.workspace && (
                    <Button variant="light" onClick={() => setAddFor(g.workspace)}>
                      <FolderPlus size={14} /><span className="hidden sm:inline">Add project</span>
                    </Button>
                  )}
                  <Button variant="light" onClick={() => openWorkspace(g)}>Open</Button>
                </div>
              )}>
              <div className="overflow-x-auto border-t border-border">
                <table className="tbl table-fixed">
                  <thead>
                    <tr>
                      {columns.map((col) => (
                        <th key={col.label || 'actions'}
                          onClick={col.key ? () => toggleSort(col.key) : undefined}
                          aria-label={col.label ? undefined : 'Open'}
                          className={`${col.cls} ${col.key ? 'cursor-pointer select-none hover:text-fg' : ''}`.trim()}>
                          {col.label}{col.key && sort.key === col.key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {g.clients.map((c) => {
                      const s = STATUS_PILLS[onboardingStatus(c)];
                      const oauthLabel = { read_only: 'Read only', ai_actions: 'AI actions', automation: 'Automation' }[c.oauthMaxPermissionLevel] || 'Read only';
                      return (
                        <tr key={c.id} onClick={() => openDrawer(c)} className="cursor-pointer hover:bg-muted/50">
                          <td>
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium truncate">{c.name}</span>
                              {c.propertyType === 'product' && <Badge tone="primary" className="shrink-0">Product</Badge>}
                            </div>
                            <div className="text-xs text-faint truncate">{c.websiteDomain || 'no domain configured'}</div>
                          </td>
                          <td>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {LIFECYCLE_PILLS[c.status] && <Badge tone={LIFECYCLE_PILLS[c.status].tone}>{LIFECYCLE_PILLS[c.status].label}</Badge>}
                              <Badge tone={s.tone}>{s.label}</Badge>
                            </div>
                          </td>
                          <td className="hidden lg:table-cell"><SetupMeter client={c} /></td>
                          <td className="hidden lg:table-cell">
                            {/* Repo AND autonomy together: a connected repo only
                                means this site CAN receive PRs, not that anything
                                is actually acting on its own. Without the second
                                badge the list reads as "wired up" for a site whose
                                agents ship nothing unattended. */}
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {c.repoConnected ? (
                                <Badge tone="outline"><GitBranch size={11} />Connected</Badge>
                              ) : (
                                <span className="text-xs text-faint">Not connected</span>
                              )}
                              {c.autoRemediationEnabled && (
                                <span title={`Ships up to ${c.autoRemediationDailyLimit ?? 30} safe fixes a day as pull requests, unattended`}>
                                  <Badge tone="green"><Bot size={11} />Auto</Badge>
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="hidden lg:table-cell"><Badge tone="grey">{oauthLabel}</Badge></td>
                          <td className="num"><ChevronRight size={14} className="text-faint inline-block" aria-hidden /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </TrayCard>
          </Tray>
        );
      })}

      <Modal isOpen={showNewForm} onClose={() => setShowNewForm(false)} title="New client" subtitle="Creates the client's login profile and initial workspace configuration." icon={Plus} maxWidth="max-w-xl">
        <NewClientForm onCreated={onCreated} onCancel={() => setShowNewForm(false)} />
      </Modal>

      {addFor && (
        <AddProjectModal workspace={addFor} isOpen onClose={() => setAddFor(null)}
          onCreated={(project) => { setAddFor(null); load(); loadWorkspaces(); setSelectedClientId(project.id); setDrawerInitialTab('integrations'); }} />
      )}

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
