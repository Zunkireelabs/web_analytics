import { useEffect, useState } from 'react';
import { api, timeAgo } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';
import {
  Building,
  Globe,
  Clock,
  CheckCircle2,
  AlertTriangle,
  GitBranch,
  Key,
  Mail,
  Lock,
  Plus,
  FolderPlus,
  RefreshCw,
  FileSpreadsheet,
  ShieldCheck,
  Settings,
  ChevronRight,
  Sliders,
  PauseCircle,
  PlayCircle,
  Trash2,
  AlertOctagon
} from 'lucide-react';

const inputCls = 'w-full text-base sm:text-xs border border-slate-200/80 rounded-xl px-3.5 py-2.5 bg-slate-50/50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#6C63FF]/10 focus:border-[#6C63FF] transition duration-150 font-medium text-slate-800 placeholder:text-slate-400';
const labelCls = 'block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5';

// The ceiling on what this client's OAuth "Connect" flow (server/routes/
// oauth-consent.js) can ever grant — 'admin' is deliberately not an option
// here, same reasoning as its absence from server/mcp/oauth-provider.js's
// computeEffectivePermissionLevel: OAuth tokens must never reach the tier
// that can mint/revoke other tokens unattended. Kept in sync by hand with
// server/mcp/permissions.js, same as McpTokensCard.jsx's TIERS already is.
const OAUTH_POLICY_OPTIONS = [
  { value: 'read_only', label: 'Read Only' },
  { value: 'ai_actions', label: 'AI Actions' },
  { value: 'automation', label: 'Automation' },
];

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

function BaselineResult({ result }) {
  const { analysis, healthScore, discovery, ingestion } = result;
  return (
    <div className="mt-4 rounded-2xl bg-gradient-to-r from-emerald-500/[0.04] to-emerald-500/[0.01] border border-emerald-500/20 p-5 space-y-4 animate-fade-in relative overflow-hidden">
      <div className="absolute left-0 inset-y-0 w-1 bg-emerald-500" />
      <div className="flex items-center gap-2">
        <span className="w-6 h-6 rounded-lg bg-emerald-500/10 text-emerald-600 grid place-items-center">
          <ShieldCheck size={14} />
        </span>
        <p className="text-xs font-black text-emerald-800 uppercase tracking-wider">Baseline Diagnostic Recorded</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {[
          { label: 'Website Health Score', val: `${healthScore ?? '—'}/100`, highlight: true },
          { label: 'Agents Activated', val: analysis?.ranAgentIds?.length ?? 0 },
          { label: 'Findings Logged', val: analysis?.findingsCount ?? 0 },
          { label: 'Sitemap Discoveries', val: discovery?.sitemapCount ?? 0 },
          { label: 'Crawled Pages', val: discovery?.crawlCount ?? 0 },
          { label: 'Ingested History', val: ingestion?.reportDate ? 'Through ' + ingestion.reportDate : '—' }
        ].map((stat, i) => (
          <div key={i} className="bg-white border border-slate-200/50 rounded-xl p-3 flex flex-col justify-between">
            <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 leading-none">{stat.label}</span>
            <span className={`text-sm font-black mt-2 font-mono ${stat.highlight ? 'text-emerald-600' : 'text-slate-800'}`}>{stat.val}</span>
          </div>
        ))}
      </div>
      
      <p className="text-[10px] text-emerald-700/80 font-medium leading-relaxed">
        Note: initial baseline captures represents day-0 audit state. Sparse metric graphs are expected for fresh properties and will accumulate delta records immediately upon the next agent cycle.
      </p>
    </div>
  );
}

function ConnectStep({ client, onConnected }) {
  const [gscProperty, setGscProperty] = useState('');
  const [ga4PropertyId, setGa4PropertyId] = useState('');
  const [reportEmailTo, setReportEmailTo] = useState('');
  const [state, setState] = useState('idle'); // idle | running | done | error
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setState('running');
    setError(null);
    try {
      const res = await api.clients.connect(client.id, { gscProperty, ga4PropertyId, reportEmailTo: reportEmailTo || undefined });
      setResult(res);
      setState('done');
      onConnected?.();
    } catch (err) {
      setError(err.message || 'Connection failed.');
      setState('error');
      onConnected?.();
    }
  };

  if (state === 'done' && result) {
    return <BaselineResult result={result} />;
  }

  return (
    <form onSubmit={submit} className="space-y-4 mt-3">
      <div className="rounded-2xl bg-amber-500/[0.04] border border-amber-500/15 p-4 text-[11px] text-amber-800 font-semibold leading-relaxed flex gap-3">
        <AlertTriangle size={16} className="text-amber-500 shrink-0 mt-0.5" />
        <div>
          Grant Google Access: Add the platform service account as a user on GSC and GA4 for <strong>{client.name}</strong> before connecting. The connection will perform real data ingestion and validation immediately.
        </div>
      </div>
      <Field label="GSC Property" value={gscProperty} onChange={(e) => setGscProperty(e.target.value)}
        placeholder="sc-domain:example.com" hint="Exact property ID from Search Console Settings Dashboard." required icon={Globe} />
      <Field label="GA4 Property ID" value={ga4PropertyId} onChange={(e) => setGa4PropertyId(e.target.value)}
        placeholder="123456789" hint="Numeric GA4 property reference ID." required icon={Sliders} />
      <Field label="Report Email Destination (Optional)" type="email" value={reportEmailTo} onChange={(e) => setReportEmailTo(e.target.value)}
        placeholder="client@example.com" icon={Mail} />
      
      {state === 'error' && (
        <div className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2">
          {error}
        </div>
      )}
      
      <button type="submit" disabled={state === 'running'}
        className="text-[10px] font-black uppercase tracking-wider px-5 py-3 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] disabled:opacity-60 shadow-md shadow-indigo-500/10 hover:shadow-indigo-500/20"
        style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>
        {state === 'running' ? 'Connecting and fetching real GSC/GA4 baseline…' : 'Connect & Fetch Baseline'}
      </button>
    </form>
  );
}

const inputMonoCls = 'w-full text-base sm:text-xs font-mono border border-slate-200/80 bg-slate-50/50 rounded-xl px-3.5 py-2.5 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#6C63FF]/10 focus:border-[#6C63FF] transition duration-150 text-slate-800 placeholder:text-slate-400';

const EXAMPLE_URL_FILE_MAP = `{
  "pages": {
    "/services/example/": { "file": "src/services/example.njk" }
  },
  "patterns": [
    { "match": "^/blog/([^/]+)/$", "file": "src/blog/$1.md" }
  ],
  "siteRoot": { "llmsTxt": "llms.txt", "robotsTxt": "robots.txt" },
  "newContentTargets": {
    "blog-outline": { "dir": "src/blog", "extension": ".md" }
  }
}`;

function RepoConnectStep({ client, onConnected }) {
  const [repoOwner, setRepoOwner] = useState('');
  const [repoName, setRepoName] = useState('');
  const [repoDefaultBranch, setRepoDefaultBranch] = useState('main');
  const [techStack, setTechStack] = useState('');
  const [githubPatEnvVar, setGithubPatEnvVar] = useState('GITHUB_PAT');
  const [urlFileMapText, setUrlFileMapText] = useState('');
  const [state, setState] = useState('idle');
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setState('running');
    setError(null);
    let urlFileMap;
    if (urlFileMapText.trim()) {
      try {
        urlFileMap = JSON.parse(urlFileMapText);
      } catch {
        setError('url_file_map is not valid JSON — check for formatting errors.');
        setState('error');
        return;
      }
    }
    try {
      await api.clients.connectRepo(client.id, { repoOwner, repoName, repoDefaultBranch, techStack: techStack || undefined, githubPatEnvVar, urlFileMap });
      setState('done');
      onConnected?.();
    } catch (err) {
      setError(err.message || 'Could not save repo config.');
      setState('error');
    }
  };

  if (state === 'done') {
    return (
      <div className="mt-3 rounded-2xl bg-gradient-to-r from-emerald-500/[0.04] to-emerald-500/[0.01] border border-emerald-500/20 p-4.5 flex items-center gap-3">
        <CheckCircle2 size={16} className="text-emerald-500" />
        <p className="text-xs font-bold text-emerald-800">GitHub repository connected successfully. Ready to deploy live PRs.</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4 mt-3">
      <div className="rounded-2xl bg-indigo-500/[0.03] border border-indigo-500/10 p-4 text-[11px] text-indigo-900 font-semibold leading-relaxed flex gap-3">
        <GitBranch size={16} className="text-indigo-500 shrink-0 mt-0.5" />
        <div>
          Git Setup: The Action Center relies on a hand-authored <code>url_file_map</code> to translate website routes to real file paths in your repository.
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Repo Owner" value={repoOwner} onChange={(e) => setRepoOwner(e.target.value)} placeholder="acme-inc" required icon={Building} />
        <Field label="Repo Name" value={repoName} onChange={(e) => setRepoName(e.target.value)} placeholder="acme-website" required icon={FolderPlus} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Default Branch" value={repoDefaultBranch} onChange={(e) => setRepoDefaultBranch(e.target.value)} placeholder="main" icon={GitBranch} />
        <Field label="Tech Stack" value={techStack} onChange={(e) => setTechStack(e.target.value)} placeholder="e.g. astro, nextjs, nunjucks" icon={Settings} />
      </div>
      <Field label="GitHub PAT Env Var Name" value={githubPatEnvVar} onChange={(e) => setGithubPatEnvVar(e.target.value)}
        placeholder="GITHUB_PAT" hint="Server-side environment variable key naming the GitHub access token." icon={Key} />
      
      <label className="block">
        <span className={labelCls}>url_file_map (JSON, optional)</span>
        <textarea className={inputMonoCls} rows={8} value={urlFileMapText} onChange={(e) => setUrlFileMapText(e.target.value)}
          placeholder={EXAMPLE_URL_FILE_MAP} />
      </label>
      
      {state === 'error' && (
        <div className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2">
          {error}
        </div>
      )}
      
      <button type="submit" disabled={state === 'running'}
        className="text-[10px] font-black uppercase tracking-wider px-5 py-3 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] disabled:opacity-60 shadow-md shadow-indigo-500/10 hover:shadow-indigo-500/20"
        style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>
        {state === 'running' ? 'Connecting Repository…' : 'Save Repo Configuration'}
      </button>
    </form>
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
        <div className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2">
          {error}
        </div>
      )}
      <button type="submit" disabled={state === 'running'}
        className="text-[10px] font-black uppercase tracking-wider px-5 py-3 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] disabled:opacity-60 shadow-md shadow-indigo-500/10 hover:shadow-indigo-500/20"
        style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>
        {state === 'running' ? 'Creating site profile…' : 'Create Client Site'}
      </button>
    </form>
  );
}

const STATUS_PILLS = {
  connected: { label: 'Active baseline', color: '#059669', bg: '#ecfdf5', border: '#a7f3d0' },
  baselinePending: { label: 'Baseline pending', color: '#d97706', bg: '#fffbeb', border: '#fef3c7' },
  pending: { label: 'Awaiting integrations', color: '#d97706', bg: '#fffbeb', border: '#fef3c7' },
};

// Tenant lifecycle status (PLATFORM-ADMIN-DESIGN.md §D) — distinct from the
// onboarding-progress pills above. Only shown when status !== 'active', so
// the common case (every tenant, today) doesn't clutter the row with a
// redundant "Active" pill next to the onboarding pill.
const LIFECYCLE_PILLS = {
  suspended: { label: 'Suspended', color: '#d97706', bg: '#fffbeb', border: '#fde68a' },
  soft_deleted: { label: 'Soft-deleted', color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
};

export default function ClientOnboarding() {
  const [clients, setClients] = useState(null); // null = loading
  const [showNewForm, setShowNewForm] = useState(false);
  const [connectingClient, setConnectingClient] = useState(null);
  const [connectingRepoClient, setConnectingRepoClient] = useState(null);
  const [retryState, setRetryState] = useState({}); // {[clientId]: 'running'|'done'|'error'}
  const [retryResult, setRetryResult] = useState({}); // {[clientId]: result | {error}}
  const [oauthPolicySaving, setOauthPolicySaving] = useState({}); // {[clientId]: true}
  const [oauthPolicyError, setOauthPolicyError] = useState({}); // {[clientId]: message}

  // Tenant lifecycle (PLATFORM-ADMIN-DESIGN.md §D, §K Phase 3/3.5).
  const [lifecycleBusy, setLifecycleBusy] = useState({}); // {[clientId]: true}
  const [lifecycleError, setLifecycleError] = useState({}); // {[clientId]: message}
  const [hardDeleteOpen, setHardDeleteOpen] = useState({}); // {[clientId]: true}
  const [hardDeleteName, setHardDeleteName] = useState({}); // {[clientId]: string}

  const [requests, setRequests] = useState(null); // null = loading
  const [reviewState, setReviewState] = useState({}); // {[requestId]: 'approving'|'rejecting'|'error'}
  const [reviewError, setReviewError] = useState({}); // {[requestId]: message}

  const load = () => api.clients.list().then(setClients).catch(() => setClients([]));
  const loadRequests = () => api.clients.signupRequests.list().then(setRequests).catch(() => setRequests([]));

  useEffect(() => { load(); loadRequests(); }, []);

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

  const retryBaseline = async (client) => {
    setRetryState((s) => ({ ...s, [client.id]: 'running' }));
    try {
      const res = await api.clients.retryBaseline(client.id);
      setRetryResult((r) => ({ ...r, [client.id]: res }));
      setRetryState((s) => ({ ...s, [client.id]: 'done' }));
      load();
    } catch (err) {
      setRetryResult((r) => ({ ...r, [client.id]: { error: err.message || 'Retry failed.' } }));
      setRetryState((s) => ({ ...s, [client.id]: 'error' }));
    }
  };

  // The trusted ceiling for this client's OAuth "Connect" flow
  // (sites.oauth_max_permission_level, migration 061) — staff-only, same
  // gating as every other control on this page. Optimistic local update so
  // the dropdown doesn't visually snap back while the request is in flight;
  // reverts via a full reload if the save actually fails.
  const updateOauthPolicy = async (client, oauthMaxPermissionLevel) => {
    const previous = client.oauthMaxPermissionLevel;
    setClients((cs) => (cs || []).map((c) => (c.id === client.id ? { ...c, oauthMaxPermissionLevel } : c)));
    setOauthPolicySaving((s) => ({ ...s, [client.id]: true }));
    setOauthPolicyError((e) => ({ ...e, [client.id]: null }));
    try {
      await api.clients.setOauthPolicy(client.id, oauthMaxPermissionLevel);
    } catch (err) {
      setClients((cs) => (cs || []).map((c) => (c.id === client.id ? { ...c, oauthMaxPermissionLevel: previous } : c)));
      setOauthPolicyError((e) => ({ ...e, [client.id]: err.message || 'Could not save.' }));
    } finally {
      setOauthPolicySaving((s) => ({ ...s, [client.id]: false }));
    }
  };

  const runLifecycleAction = async (client, action, onSuccess) => {
    setLifecycleBusy((s) => ({ ...s, [client.id]: true }));
    setLifecycleError((e) => ({ ...e, [client.id]: null }));
    try {
      await action();
      await load();
      onSuccess?.();
    } catch (err) {
      setLifecycleError((e) => ({ ...e, [client.id]: err.message || 'Action failed.' }));
    } finally {
      setLifecycleBusy((s) => ({ ...s, [client.id]: false }));
    }
  };

  const suspend = (client) => {
    if (!confirm(`Suspend ${client.name}? This immediately blocks all access to their dashboard, MCP tokens, and OAuth grants.`)) return;
    runLifecycleAction(client, () => api.clients.suspend(client.id));
  };

  const reactivate = (client) => runLifecycleAction(client, () => api.clients.reactivate(client.id));

  const softDelete = (client) => {
    if (!confirm(`Soft-delete ${client.name}? Data is retained and this is reversible via Reactivate.`)) return;
    runLifecycleAction(client, () => api.clients.softDelete(client.id));
  };

  const hardDelete = (client) => {
    runLifecycleAction(client, () => api.clients.hardDelete(client.id, hardDeleteName[client.id] || ''), () => {
      setHardDeleteOpen((o) => ({ ...o, [client.id]: false }));
      setHardDeleteName((n) => ({ ...n, [client.id]: '' }));
    });
  };

  const onCreated = (site) => {
    setShowNewForm(false);
    setConnectingClient({ id: site.id, name: site.name });
    load();
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      
      {/* Decorative ambiance background */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden no-print">
        <div className="absolute top-0 right-1/3 w-[550px] h-[550px] rounded-full blur-[140px] bg-indigo-500/5 opacity-30 pulse-glow" />
      </div>

      <PageHeader 
        title="Client Registry" 
        icon="🏢"
        subtitle="Manage client credentials, Stage GSC/GA4 property linkings, and run day-0 baseline snapshots."
        right={
          <button 
            type="button" 
            onClick={() => setShowNewForm((s) => !s)}
            className="text-[10px] font-black uppercase tracking-wider px-4.5 py-2.5 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] shadow-md shadow-indigo-500/10 hover:shadow-indigo-500/20 flex items-center gap-1.5"
            style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
          >
            {showNewForm ? 'Cancel' : (
              <>
                <Plus size={12} strokeWidth={2.5} />
                <span>New Client</span>
              </>
            )}
          </button>
        } 
      />

      {/* Grid containing forms and details */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        
        {/* Left Side (lg-7) - Creation, Connect forms & Requests */}
        <div className="lg:col-span-7 space-y-6">
          
          {/* Public Signup Requests */}
          <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-6 space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-xs font-black uppercase tracking-widest text-slate-400">Pending Registrations</h3>
                <p className="text-[10px] text-slate-450 font-semibold mt-0.5">Prospect requests generated from website access form</p>
              </div>
              {requests && requests.length > 0 && (
                <span className="text-[9px] font-black uppercase tracking-wider bg-indigo-50 border border-indigo-100/50 text-indigo-600 px-2.5 py-0.5 rounded-full">
                  {requests.length} pending
                </span>
              )}
            </div>

            {requests === null ? (
              <div className="p-8 text-center text-xs text-slate-400 animate-pulse">Checking database logs…</div>
            ) : requests.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-400 italic">No pending signup requests found.</div>
            ) : (
              <div className="divide-y divide-slate-100">
                {requests.map((r) => {
                  const state = reviewState[r.id];
                  const busy = state === 'approving' || state === 'rejecting';
                  return (
                    <div key={r.id} className="py-3.5 flex flex-col gap-2">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-black text-slate-800 leading-snug">{r.companyName}</p>
                          <p className="text-[10px] text-slate-400 font-semibold mt-0.5 truncate">
                            {r.contactEmail} {r.websiteDomain && `· ${r.websiteDomain}`} · requested {timeAgo(r.createdAt)}
                          </p>
                          {r.message && (
                            <p className="text-[10.5px] font-medium text-slate-500 bg-slate-50/50 border border-slate-100 rounded-xl p-3.5 mt-2 leading-relaxed italic">
                              "{r.message}"
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <button type="button" onClick={() => approveRequest(r)} disabled={busy}
                            className="text-[9.5px] font-black uppercase tracking-wider px-3 py-2.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-700 transition disabled:opacity-60 active:scale-95">
                            {state === 'approving' ? 'Approve…' : 'Approve'}
                          </button>
                          <button type="button" onClick={() => rejectRequest(r)} disabled={busy}
                            className="text-[9.5px] font-black uppercase tracking-wider px-3 py-2.5 rounded-lg bg-slate-50 hover:bg-slate-100 text-slate-500 transition disabled:opacity-60 active:scale-95">
                            {state === 'rejecting' ? 'Reject…' : 'Reject'}
                          </button>
                        </div>
                      </div>
                      {reviewError[r.id] && <p className="text-[10px] font-semibold text-rose-600 leading-relaxed mt-1">{reviewError[r.id]}</p>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Form Step 1: Create Client */}
          {showNewForm && (
            <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-6 space-y-4 animate-fade-in">
              <div className="border-b border-slate-100 pb-3">
                <h3 className="text-xs font-black uppercase tracking-widest text-slate-400">Step 1 — Create client</h3>
                <p className="text-[10px] text-slate-450 font-semibold mt-0.5">Creates target login profile and initial workspace configurations</p>
              </div>
              <NewClientForm onCreated={onCreated} />
            </div>
          )}

          {/* Form Step 2: Connect client integrations */}
          {connectingClient && (
            <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-6 space-y-4 animate-fade-in">
              <div className="border-b border-slate-100 pb-3 flex justify-between items-center gap-3">
                <div>
                  <h3 className="text-xs font-black uppercase tracking-widest text-slate-400">Step 2 — Connect Integrations</h3>
                  <p className="text-[10px] text-slate-450 font-semibold mt-0.5">Authorize GA4 and GSC access endpoints for <strong>{connectingClient.name}</strong></p>
                </div>
                <button type="button" onClick={() => setConnectingClient(null)} className="text-[10px] font-bold text-slate-400 hover:text-slate-600 uppercase tracking-widest">
                  Skip / Close
                </button>
              </div>
              <ConnectStep client={connectingClient} onConnected={load} />
            </div>
          )}

          {/* Form Step 3: Connect repository connection */}
          {connectingRepoClient && (
            <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-6 space-y-4 animate-fade-in">
              <div className="border-b border-slate-100 pb-3 flex justify-between items-center gap-3">
                <div>
                  <h3 className="text-xs font-black uppercase tracking-widest text-[#6C63FF]">Step 3 (Optional) — Git Integration</h3>
                  <p className="text-[10px] text-slate-450 font-semibold mt-0.5">Configure GitHub webhook triggers and repositories for <strong>{connectingRepoClient.name}</strong></p>
                </div>
                <button type="button" onClick={() => setConnectingRepoClient(null)} className="text-[10px] font-bold text-slate-400 hover:text-slate-600 uppercase tracking-widest">
                  Close
                </button>
              </div>
              <RepoConnectStep client={connectingRepoClient} onConnected={load} />
            </div>
          )}

        </div>

        {/* Right Side (lg-5) - Clients List */}
        <div className="lg:col-span-5 space-y-4">
          
          <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-6 space-y-4">
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-xs font-black uppercase tracking-widest text-slate-400">Registered Accounts</h3>
                <p className="text-[10px] text-slate-450 font-semibold mt-0.5">Direct sites monitored by automated specialist agents</p>
              </div>
              {clients && clients.length > 0 && (
                <span className="text-[9px] font-mono font-bold bg-slate-100 text-slate-500 border border-slate-200/50 px-2 py-0.5 rounded">
                  {clients.length} total
                </span>
              )}
            </div>

            {clients === null ? (
              <div className="p-8 text-center text-xs text-slate-400 animate-pulse">Accessing directory nodes…</div>
            ) : clients.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-400 italic">No registered client sites on record.</div>
            ) : (
              <div className="divide-y divide-slate-100/70">
                {clients.map((c) => {
                  const s = !c.connected ? STATUS_PILLS.pending : c.baselined ? STATUS_PILLS.connected : STATUS_PILLS.baselinePending;
                  const rState = retryState[c.id];
                  const rResult = retryResult[c.id];
                  return (
                    <div key={c.id} className="py-4 space-y-3">
                      <div className="flex items-center gap-3 justify-between">
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-black text-slate-900 leading-snug truncate">{c.name}</p>
                          <p className="text-[9.5px] font-mono text-slate-400 mt-1 truncate">
                            {c.websiteDomain || 'no domain configured'}
                          </p>
                          {c.onboardedAt && (
                            <span className="block text-[8px] font-bold text-slate-400 uppercase tracking-wide mt-1">
                              Created {timeAgo(c.onboardedAt)}
                            </span>
                          )}
                        </div>

                        <div className="shrink-0 flex flex-col items-end gap-1.5">
                          {LIFECYCLE_PILLS[c.status] && (
                            <span className="text-[8px] font-black uppercase tracking-widest px-2 py-0.5 rounded border leading-none"
                              style={{ color: LIFECYCLE_PILLS[c.status].color, backgroundColor: LIFECYCLE_PILLS[c.status].bg, borderColor: LIFECYCLE_PILLS[c.status].border }}>
                              {LIFECYCLE_PILLS[c.status].label}
                            </span>
                          )}
                          <span className="text-[8px] font-black uppercase tracking-widest px-2 py-0.5 rounded border leading-none"
                            style={{ color: s.color, backgroundColor: s.bg, borderColor: s.border }}>
                            {s.label}
                          </span>
                          {c.repoConnected && (
                            <span className="text-[8px] font-black uppercase tracking-widest px-2 py-0.5 rounded border border-slate-200 text-slate-500 bg-slate-50 leading-none">
                              Git link
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Row actions */}
                      <div className="flex items-center gap-2.5 flex-wrap pt-2 border-t border-slate-100/50">
                        {!c.connected && (
                          <button type="button" onClick={() => setConnectingClient({ id: c.id, name: c.name })}
                            className="text-[9px] font-black uppercase tracking-widest px-3 py-2.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-650 transition active:scale-95">
                            Connect API
                          </button>
                        )}
                        {c.connected && !c.baselined && (
                          <button type="button" onClick={() => retryBaseline(c)} disabled={rState === 'running'}
                            className="text-[9px] font-black uppercase tracking-widest px-3 py-2.5 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-100 transition disabled:opacity-60 active:scale-95 flex items-center gap-1">
                            <RefreshCw size={9} className={rState === 'running' ? 'animate-spin' : ''} />
                            <span>Retry Ingest</span>
                          </button>
                        )}
                        <button type="button" onClick={() => setConnectingRepoClient({ id: c.id, name: c.name })}
                          className="text-[9px] font-black uppercase tracking-widest px-3 py-2.5 rounded-lg bg-slate-50 hover:bg-slate-100 text-slate-500 border border-slate-200/50 transition active:scale-95 flex items-center gap-1">
                          <GitBranch size={9} />
                          <span>{c.repoConnected ? 'Edit Repo' : 'Link Repo'}</span>
                        </button>
                      </div>

                      {/* Tenant lifecycle (PLATFORM-ADMIN-DESIGN.md §D, §K
                          Phase 3/3.5). The company's own site never reaches
                          this row with an active suspend/delete path — the
                          server rejects COMPANY_SITE_ID unconditionally
                          regardless of what this UI shows, this is just
                          normal staff console UX on top of that guard. */}
                      <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-slate-100/50">
                        {c.status === 'active' && (
                          <button type="button" onClick={() => suspend(c)} disabled={!!lifecycleBusy[c.id]}
                            className="text-[9px] font-black uppercase tracking-widest px-3 py-2.5 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-100 transition disabled:opacity-60 active:scale-95 flex items-center gap-1">
                            <PauseCircle size={9} />
                            <span>Suspend</span>
                          </button>
                        )}
                        {(c.status === 'suspended' || c.status === 'soft_deleted') && (
                          <button type="button" onClick={() => reactivate(c)} disabled={!!lifecycleBusy[c.id]}
                            className="text-[9px] font-black uppercase tracking-widest px-3 py-2.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-100 transition disabled:opacity-60 active:scale-95 flex items-center gap-1">
                            <PlayCircle size={9} />
                            <span>Reactivate</span>
                          </button>
                        )}
                        {c.status === 'suspended' && (
                          <button type="button" onClick={() => softDelete(c)} disabled={!!lifecycleBusy[c.id]}
                            className="text-[9px] font-black uppercase tracking-widest px-3 py-2.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-100 transition disabled:opacity-60 active:scale-95 flex items-center gap-1">
                            <Trash2 size={9} />
                            <span>Soft Delete</span>
                          </button>
                        )}
                        {c.status === 'soft_deleted' && !hardDeleteOpen[c.id] && (
                          <button type="button" onClick={() => setHardDeleteOpen((o) => ({ ...o, [c.id]: true }))}
                            className="text-[9px] font-black uppercase tracking-widest px-3 py-2.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white transition active:scale-95 flex items-center gap-1">
                            <AlertOctagon size={9} />
                            <span>Hard Delete…</span>
                          </button>
                        )}
                      </div>

                      {lifecycleError[c.id] && (
                        <div className="text-[10px] font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2 leading-relaxed">
                          {lifecycleError[c.id]}
                        </div>
                      )}

                      {c.status === 'soft_deleted' && hardDeleteOpen[c.id] && (
                        <div className="rounded-2xl bg-rose-500/[0.04] border border-rose-500/20 p-4 space-y-3">
                          <p className="text-[11px] font-bold text-rose-800 leading-relaxed">
                            This permanently and irreversibly deletes <strong>{c.name}</strong> and all its data.
                            Type the tenant's exact name to confirm.
                          </p>
                          <input
                            className={inputCls}
                            value={hardDeleteName[c.id] || ''}
                            onChange={(e) => setHardDeleteName((n) => ({ ...n, [c.id]: e.target.value }))}
                            placeholder={c.name}
                          />
                          <div className="flex gap-2">
                            <button type="button" onClick={() => hardDelete(c)}
                              disabled={!!lifecycleBusy[c.id] || (hardDeleteName[c.id] || '').trim() !== c.name}
                              className="text-[10px] font-black uppercase tracking-wider px-4 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white transition disabled:opacity-40">
                              {lifecycleBusy[c.id] ? 'Deleting…' : 'Permanently Delete'}
                            </button>
                            <button type="button"
                              onClick={() => { setHardDeleteOpen((o) => ({ ...o, [c.id]: false })); setHardDeleteName((n) => ({ ...n, [c.id]: '' })); }}
                              className="text-[10px] font-black uppercase tracking-wider px-4 py-2.5 rounded-xl bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 transition">
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}

                      {/* OAuth "Connect" ceiling — the max permission_level this
                          client's OAuth grants (server/routes/oauth-consent.js)
                          can ever reach. 'admin' deliberately isn't an option;
                          see OAUTH_POLICY_OPTIONS above. */}
                      <div className="flex items-center gap-2 pt-1">
                        <ShieldCheck size={11} className="text-slate-400 shrink-0" />
                        <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 shrink-0">OAuth ceiling</span>
                        <select
                          value={c.oauthMaxPermissionLevel || 'read_only'}
                          disabled={!!oauthPolicySaving[c.id]}
                          onChange={(e) => updateOauthPolicy(c, e.target.value)}
                          className="text-[10px] font-bold text-slate-700 border border-slate-200/80 rounded-lg px-2 py-1 bg-white disabled:opacity-60"
                        >
                          {OAUTH_POLICY_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </div>
                      {oauthPolicyError[c.id] && (
                        <div className="text-[10px] font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2 leading-relaxed">
                          {oauthPolicyError[c.id]}
                        </div>
                      )}

                      {/* Diagnostic baselining results */}
                      {rState === 'done' && rResult && !rResult.error && <BaselineResult result={rResult} />}
                      {rState === 'error' && rResult?.error && (
                        <div className="text-[10px] font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2 leading-relaxed">
                          {rResult.error}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

        </div>

      </div>
    </div>
  );
}
