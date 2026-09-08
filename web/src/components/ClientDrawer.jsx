import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, timeAgo } from '../api.js';
import {
  Building, Globe, Clock, CheckCircle2, AlertTriangle, GitBranch, Key, Mail, Lock,
  FolderPlus, RefreshCw, ShieldCheck, Settings, Sliders, PauseCircle, PlayCircle,
  Trash2, AlertOctagon, HelpCircle, DollarSign, User, Bot, Palette, ArrowRight,
} from 'lucide-react';
import Drawer from './Drawer.jsx';
import Tabs from './Tabs.jsx';
import Avatar from './Avatar.jsx';
import ClientBusinessValuesPanel from './ClientBusinessValuesPanel.jsx';

const inputCls = 'w-full text-base sm:text-xs border border-slate-200/80 rounded-xl px-3.5 py-2.5 bg-slate-50/50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#6C63FF]/10 focus:border-[#6C63FF] transition duration-150 font-medium text-slate-800 placeholder:text-slate-400';
const labelCls = 'block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5';
const inputMonoCls = 'w-full text-base sm:text-xs font-mono border border-slate-200/80 bg-slate-50/50 rounded-xl px-3.5 py-2.5 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#6C63FF]/10 focus:border-[#6C63FF] transition duration-150 text-slate-800 placeholder:text-slate-400';

// The ceiling on what this client's OAuth "Connect" flow (server/routes/
// oauth-consent.js) can ever grant — 'admin' is deliberately not an option
// here, same reasoning as its absence from mcp-server/oauth-provider.js's
// computeEffectivePermissionLevel. Kept in sync by hand with
// mcp-server/permissions.js, same as McpTokensCard.jsx's TIERS already is.
const OAUTH_POLICY_OPTIONS = [
  { value: 'read_only', label: 'Read Only' },
  { value: 'ai_actions', label: 'AI Actions' },
  { value: 'automation', label: 'Automation' },
];

const STATUS_PILLS = {
  connected: { label: 'Active baseline', className: 'bg-emerald-50 text-emerald-700 border-emerald-100' },
  baselinePending: { label: 'Baseline pending', className: 'bg-amber-50 text-amber-700 border-amber-100' },
  pending: { label: 'Awaiting integrations', className: 'bg-amber-50 text-amber-700 border-amber-100' },
};

const LIFECYCLE_PILLS = {
  suspended: { label: 'Suspended', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  soft_deleted: { label: 'Soft-deleted', className: 'bg-rose-50 text-rose-700 border-rose-200' },
};

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
          { label: 'Ingested History', val: ingestion?.reportDate ? 'Through ' + ingestion.reportDate : '—' },
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
  const [state, setState] = useState('idle');
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

  if (state === 'done' && result) return <BaselineResult result={result} />;

  return (
    <form onSubmit={submit} className="space-y-4">
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
        <div className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2">{error}</div>
      )}
      <button type="submit" disabled={state === 'running'}
        className="text-[10px] font-black uppercase tracking-wider px-5 py-3 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] disabled:opacity-60 shadow-md shadow-indigo-500/10 hover:shadow-indigo-500/20"
        style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>
        {state === 'running' ? 'Connecting and fetching real GSC/GA4 baseline…' : 'Connect & Fetch Baseline'}
      </button>
    </form>
  );
}

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
  const [repoOwner, setRepoOwner] = useState(client.repoOwner || '');
  const [repoName, setRepoName] = useState(client.repoName || '');
  const [repoDefaultBranch, setRepoDefaultBranch] = useState('main');
  const [techStack, setTechStack] = useState('');
  const [githubPatEnvVar, setGithubPatEnvVar] = useState(client.githubPatEnvVar || 'GITHUB_PAT');
  const [githubAppInstallationId, setGithubAppInstallationId] = useState(client.githubAppInstallationId ?? '');
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
    const trimmedInstallationId = String(githubAppInstallationId).trim();
    if (trimmedInstallationId && !/^\d+$/.test(trimmedInstallationId)) {
      setError('GitHub App Installation ID must be a whole number.');
      setState('error');
      return;
    }
    try {
      await api.clients.connectRepo(client.id, {
        repoOwner, repoName, repoDefaultBranch, techStack: techStack || undefined, githubPatEnvVar,
        githubAppInstallationId: trimmedInstallationId ? Number(trimmedInstallationId) : null,
        urlFileMap,
      });
      setState('done');
      onConnected?.();
    } catch (err) {
      setError(err.message || 'Could not save repo config.');
      setState('error');
    }
  };

  if (state === 'done') {
    return (
      <div className="rounded-2xl bg-gradient-to-r from-emerald-500/[0.04] to-emerald-500/[0.01] border border-emerald-500/20 p-4 flex items-center gap-3">
        <CheckCircle2 size={16} className="text-emerald-500" />
        <p className="text-xs font-bold text-emerald-800">GitHub repository connected successfully. Ready to deploy live PRs.</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
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
      <Field label="GitHub App Installation ID (optional)" value={githubAppInstallationId} onChange={(e) => setGithubAppInstallationId(e.target.value)}
        placeholder="e.g. 64837201"
        hint="Overrides the PAT above entirely once set — tokens are minted per-installation instead of shared. Usually filled in automatically once the client installs the GitHub App; leave blank to keep using the PAT, or clear it to move back."
        icon={Key} />
      <label className="block">
        <span className={labelCls}>url_file_map (JSON, optional)</span>
        <textarea className={inputMonoCls} rows={8} value={urlFileMapText} onChange={(e) => setUrlFileMapText(e.target.value)}
          placeholder={EXAMPLE_URL_FILE_MAP} />
      </label>
      {state === 'error' && (
        <div className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2">{error}</div>
      )}
      <button type="submit" disabled={state === 'running'}
        className="text-[10px] font-black uppercase tracking-wider px-5 py-3 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] disabled:opacity-60 shadow-md shadow-indigo-500/10 hover:shadow-indigo-500/20"
        style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>
        {state === 'running' ? 'Connecting Repository…' : 'Save Repo Configuration'}
      </button>
    </form>
  );
}

function StatusPill({ client }) {
  const s = !client.connected ? STATUS_PILLS.pending : client.baselined ? STATUS_PILLS.connected : STATUS_PILLS.baselinePending;
  return (
    <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-md border ${s.className}`}>{s.label}</span>
  );
}

// ── General tab ──────────────────────────────────────────────────────────
function GeneralTab({ client, owner }) {
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3.5">
        <Avatar email={client.name} size="lg" />
        <div className="min-w-0">
          <p className="text-sm font-black text-slate-900 truncate">{client.name}</p>
          <p className="text-[11px] font-mono text-slate-400 truncate">{client.websiteDomain || 'no domain configured'}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {[
          { label: 'Website', icon: Globe, value: client.websiteDomain || '—' },
          { label: 'Owner', icon: User, value: owner ? owner.email : '—' },
          { label: 'Timezone', icon: Clock, value: client.timezone || '—' },
          { label: 'Created', icon: Clock, value: client.onboardedAt ? timeAgo(client.onboardedAt) : (client.createdAt ? timeAgo(client.createdAt) : '—') },
        ].map((f) => (
          <div key={f.label} className="border border-slate-100 rounded-xl px-3.5 py-3">
            <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
              <f.icon size={11} /> {f.label}
            </span>
            <p className="text-xs font-bold text-slate-800 mt-1 truncate">{f.value}</p>
          </div>
        ))}
      </div>

      <div>
        <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 block mb-1.5">Status</span>
        <div className="flex items-center gap-1.5 flex-wrap">
          {LIFECYCLE_PILLS[client.status] && (
            <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-md border ${LIFECYCLE_PILLS[client.status].className}`}>
              {LIFECYCLE_PILLS[client.status].label}
            </span>
          )}
          <StatusPill client={client} />
          {client.repoConnected && (
            <span className="text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-md border border-slate-200 text-slate-500 bg-slate-50">
              Git link
            </span>
          )}
        </div>
      </div>

      <p className="text-[10.5px] font-semibold text-slate-400 leading-relaxed border-t border-slate-100 pt-4">
        Suspend and delete controls live under the Advanced tab's Danger Zone.
      </p>
    </div>
  );
}

// ── Integrations tab ─────────────────────────────────────────────────────
function IntegrationsTab({ client, onReload }) {
  const [connecting, setConnecting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryResult, setRetryResult] = useState(null);
  const [retryError, setRetryError] = useState(null);

  // The two IDs generators/analytics-install.js reads live at draft time
  // (server/db.js's updateSiteAnalyticsIds) — separate from "GA4 Property
  // ID" above, which is the Data API reporting property this dashboard
  // ingests from, not the on-site gtag/Pixel install target. Saved together,
  // same paired-save shape as auto-remediation's enabled+dailyLimit, since
  // the server route takes both in one PATCH.
  const [ga4MeasurementId, setGa4MeasurementId] = useState(client.ga4MeasurementId || '');
  const [facebookPixelId, setFacebookPixelId] = useState(client.facebookPixelId || '');
  const [analyticsIdsSaving, setAnalyticsIdsSaving] = useState(false);
  const [analyticsIdsError, setAnalyticsIdsError] = useState(null);
  const [analyticsIdsSaved, setAnalyticsIdsSaved] = useState(false);

  const saveAnalyticsIds = async () => {
    setAnalyticsIdsSaving(true);
    setAnalyticsIdsError(null);
    setAnalyticsIdsSaved(false);
    try {
      await api.clients.setAnalyticsIds(client.id, ga4MeasurementId.trim(), facebookPixelId.trim());
      setAnalyticsIdsSaved(true);
      onReload();
    } catch (err) {
      setAnalyticsIdsError(err.message || 'Could not save.');
    } finally {
      setAnalyticsIdsSaving(false);
    }
  };

  const retryBaseline = async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      const res = await api.clients.retryBaseline(client.id);
      setRetryResult(res);
      onReload();
    } catch (err) {
      setRetryError(err.message || 'Retry failed.');
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="border border-slate-100 rounded-xl px-3.5 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
            <ShieldCheck size={11} /> OAuth status
          </span>
          <p className="text-xs font-bold text-slate-800 mt-1">
            {!client.connected ? 'Not connected' : client.baselined ? 'Connected — active baseline' : 'Connected — baseline pending'}
          </p>
        </div>
        <StatusPill client={client} />
      </div>

      {!client.connected && !connecting && (
        <button type="button" onClick={() => setConnecting(true)}
          className="text-[10px] font-black uppercase tracking-wider px-4 py-2.5 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-650 transition">
          Connect API
        </button>
      )}
      {!client.connected && connecting && (
        <ConnectStep client={client} onConnected={onReload} />
      )}

      {client.connected && !client.baselined && (
        <div>
          <button type="button" onClick={retryBaseline} disabled={retrying}
            className="text-[10px] font-black uppercase tracking-wider px-4 py-2.5 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-100 transition disabled:opacity-60 flex items-center gap-1.5">
            <RefreshCw size={11} className={retrying ? 'animate-spin' : ''} />
            <span>{retrying ? 'Syncing…' : 'Sync now (Retry Ingest)'}</span>
          </button>
          {retryError && (
            <div className="text-[10px] font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2 mt-2">{retryError}</div>
          )}
          {retryResult && !retryResult.error && <BaselineResult result={retryResult} />}
        </div>
      )}

      <div className="border-t border-slate-100 pt-4">
        <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5 mb-1">
          <GitBranch size={11} /> Repository connection
        </span>
        <p className="text-xs font-bold text-slate-800">{client.repoConnected ? 'Connected' : 'Not connected'}</p>
        <p className="text-[10.5px] font-semibold text-slate-400 mt-1">Manage repository details in the Repository tab.</p>
      </div>

      {/* GA4/Meta Pixel install target — what the Action Center's
          analytics-install generator drafts a script for. Distinct from
          "GA4 Property ID" above (the reporting ingestion source). */}
      <div className="border-t border-slate-100 pt-4">
        <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5 mb-2">
          <Globe size={11} /> Analytics install (GA4 / Meta Pixel)
        </span>
        <div className="space-y-2.5">
          <Field label="GA4 Measurement ID" value={ga4MeasurementId}
            onChange={(e) => { setGa4MeasurementId(e.target.value); setAnalyticsIdsSaved(false); }}
            placeholder="G-XXXXXXXXXX" hint="Used for the on-site gtag install script, not the reporting property above." />
          <Field label="Meta (Facebook) Pixel ID" value={facebookPixelId}
            onChange={(e) => { setFacebookPixelId(e.target.value); setAnalyticsIdsSaved(false); }}
            placeholder="123456789012345" hint="Numeric Pixel ID from Meta Events Manager." />
        </div>
        <button type="button" onClick={saveAnalyticsIds} disabled={analyticsIdsSaving}
          className="mt-2.5 text-[10px] font-black uppercase tracking-wider px-4 py-2.5 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-650 transition disabled:opacity-60">
          {analyticsIdsSaving ? 'Saving…' : 'Save Analytics IDs'}
        </button>
        {analyticsIdsSaved && !analyticsIdsError && (
          <p className="text-[10px] font-bold text-emerald-700 mt-1.5">Saved — the next analytics-install draft will use this.</p>
        )}
        {analyticsIdsError && (
          <div className="text-[10px] font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2 mt-2">{analyticsIdsError}</div>
        )}
      </div>
    </div>
  );
}

// ── AI Configuration tab ─────────────────────────────────────────────────
function AiConfigTab({ client, onReload }) {
  const navigate = useNavigate();
  const [oauthLevel, setOauthLevel] = useState(client.oauthMaxPermissionLevel || 'read_only');
  const [oauthSaving, setOauthSaving] = useState(false);
  const [oauthError, setOauthError] = useState(null);

  const [faqCap, setFaqCap] = useState(client.visibleFaqCap ?? 5);
  const [faqCapSaving, setFaqCapSaving] = useState(false);
  const [faqCapError, setFaqCapError] = useState(null);

  const [faqBaselineBusy, setFaqBaselineBusy] = useState(false);
  const [faqBaselineError, setFaqBaselineError] = useState(null);
  const [faqBaseline, setFaqBaseline] = useState(client.visibleFaqBaseline ?? 0);

  const [businessValuesOpen, setBusinessValuesOpen] = useState(false);

  // The unattended auto-remediation loop's switch (server/db.js's
  // updateSiteAutoRemediation). enabled and dailyLimit save together because
  // the server takes them together — see that route's comment.
  const [autoOn, setAutoOn] = useState(!!client.autoRemediationEnabled);
  const [autoLimit, setAutoLimit] = useState(client.autoRemediationDailyLimit ?? 30);
  const [autoSaving, setAutoSaving] = useState(false);
  const [autoError, setAutoError] = useState(null);

  const changeOauthLevel = async (value) => {
    const previous = oauthLevel;
    setOauthLevel(value);
    setOauthSaving(true);
    setOauthError(null);
    try {
      await api.clients.setOauthPolicy(client.id, value);
      onReload();
    } catch (err) {
      setOauthLevel(previous);
      setOauthError(err.message || 'Could not save.');
    } finally {
      setOauthSaving(false);
    }
  };

  const changeFaqCap = async (n) => {
    if (!Number.isInteger(n) || n < 0) return;
    const previous = faqCap;
    setFaqCap(n);
    setFaqCapSaving(true);
    setFaqCapError(null);
    try {
      await api.clients.setVisibleFaqCap(client.id, n);
      onReload();
    } catch (err) {
      setFaqCap(previous);
      setFaqCapError(err.message || 'Could not save.');
    } finally {
      setFaqCapSaving(false);
    }
  };

  const saveAutoRemediation = async (nextOn, nextLimit) => {
    if (!Number.isInteger(nextLimit) || nextLimit < 0) return;
    const prevOn = autoOn;
    const prevLimit = autoLimit;
    setAutoOn(nextOn);
    setAutoLimit(nextLimit);
    setAutoSaving(true);
    setAutoError(null);
    try {
      await api.clients.setAutoRemediation(client.id, nextOn, nextLimit);
      onReload();
    } catch (err) {
      setAutoOn(prevOn);
      setAutoLimit(prevLimit);
      setAutoError(err.message || 'Could not save.');
    } finally {
      setAutoSaving(false);
    }
  };

  const recalculateFaqBaseline = async () => {
    setFaqBaselineBusy(true);
    setFaqBaselineError(null);
    try {
      const result = await api.clients.recalculateFaqBaseline(client.id);
      setFaqBaseline(result.visibleFaqBaseline);
      onReload();
    } catch (err) {
      setFaqBaselineError(err.message || 'Could not recalculate.');
    } finally {
      setFaqBaselineBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Autonomous fixes — the switch for agents/lib/auto-remediation.js.
          First in this tab because it's the only setting here that decides
          whether this site's agents act on their own at all; everything
          below tunes behavior that only matters once they do.

          The no-repo case states its reason inline and disables the toggle
          rather than letting the click fail against the server's own guard —
          engineering lesson button-state-visibility. */}
      <div>
        <div className="flex items-center gap-2">
          <Bot size={12} className="text-slate-400 shrink-0" />
          <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 shrink-0">Autonomous fixes</span>
          <button
            type="button"
            onClick={() => saveAutoRemediation(!autoOn, autoLimit)}
            disabled={autoSaving || !client.repoConnected}
            className={`text-[10px] font-black uppercase tracking-wider px-2.5 py-1.5 rounded-lg border transition disabled:opacity-50 disabled:cursor-not-allowed ${
              autoOn
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : 'bg-slate-50 text-slate-500 border-slate-200'
            }`}
          >
            {autoSaving ? 'Saving…' : autoOn ? 'On' : 'Off'}
          </button>
          {autoOn && (
            <>
              <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 shrink-0">Max/day</span>
              <input
                type="number" min="0" value={autoLimit} disabled={autoSaving}
                onChange={(e) => setAutoLimit(Number(e.target.value))}
                onBlur={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isInteger(n) && n >= 0 && n !== (client.autoRemediationDailyLimit ?? 30)) saveAutoRemediation(autoOn, n);
                }}
                className="w-16 text-[10px] font-bold text-slate-700 border border-slate-200/80 rounded-lg px-2 py-1.5 bg-white disabled:opacity-60"
              />
            </>
          )}
        </div>
        <p className="text-[10px] font-medium text-slate-500 mt-2 leading-relaxed">
          {!client.repoConnected
            ? 'No GitHub repository is connected for this site, so autonomous fixes would have nowhere to open a pull request. Connect a repo first.'
            : autoOn
              ? `Every morning this site's safe-tier fixes are drafted, validated and pushed as pull requests — up to ${autoLimit} a day — without anyone clicking anything. A human still reviews and merges every PR; nothing is ever merged automatically.`
              : 'This site\'s agents will keep finding and recommending fixes, but nothing ships until someone acts on each one in the Action Center.'}
        </p>
        {autoError && <div className="text-[10px] font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2 mt-2">{autoError}</div>}
        {/* The design-integrity gate: the server now REFUSES to enable
            autonomous fixes for a site whose design was never reviewed (or
            was re-derived since it was approved) — see
            validateAutoRemediationRequest, routes/clients.js. Clicking On
            above without this done first fails with exactly that message
            in autoError above; this link is the actual next step. */}
        <button
          type="button"
          onClick={() => navigate(`/clients/${client.id}/design-review`)}
          className="mt-2 inline-flex items-center gap-1.5 text-[10.5px] font-bold text-[#6C63FF] hover:text-[#5951e0] transition"
        >
          <Palette size={11} /> Review this site's design <ArrowRight size={11} />
        </button>
      </div>

      {/* OAuth "Connect" ceiling — the max permission_level this client's
          OAuth grants (server/routes/oauth-consent.js) can ever reach.
          'admin' deliberately isn't an option; see OAUTH_POLICY_OPTIONS. */}
      <div>
        <div className="flex items-center gap-2">
          <ShieldCheck size={12} className="text-slate-400 shrink-0" />
          <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 shrink-0">OAuth ceiling</span>
          <select value={oauthLevel} disabled={oauthSaving} onChange={(e) => changeOauthLevel(e.target.value)}
            className="text-[10px] font-bold text-slate-700 border border-slate-200/80 rounded-lg px-2 py-1.5 bg-white disabled:opacity-60">
            {OAUTH_POLICY_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
        </div>
        {oauthError && <div className="text-[10px] font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2 mt-2">{oauthError}</div>}
      </div>

      {/* Sitewide visible-FAQ cap. */}
      <div>
        <div className="flex items-center gap-2">
          <HelpCircle size={12} className="text-slate-400 shrink-0" />
          <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 shrink-0">Visible FAQ cap</span>
          <input type="number" min={0} step={1} value={faqCap} disabled={faqCapSaving}
            onChange={(e) => changeFaqCap(Number(e.target.value))}
            className="w-16 text-[10px] font-bold text-slate-700 border border-slate-200/80 rounded-lg px-2 py-1.5 bg-white disabled:opacity-60" />
        </div>
        {faqCapError && <div className="text-[10px] font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2 mt-2">{faqCapError}</div>}
      </div>

      {/* Real $ inputs for the Analyst dashboard's Expected Business Impact projections. */}
      <div>
        <div className="flex items-center gap-2">
          <DollarSign size={12} className="text-slate-400 shrink-0" />
          <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 shrink-0">Business values</span>
          <button type="button" onClick={() => setBusinessValuesOpen((o) => !o)}
            className="text-[10px] font-bold text-[#6C63FF] hover:text-[#5750d9] transition">
            {businessValuesOpen ? 'Hide' : 'Configure…'}
          </button>
        </div>
        {businessValuesOpen && <div className="mt-2"><ClientBusinessValuesPanel clientId={client.id} /></div>}
      </div>

      {/* Organic (pre-existing) visible FAQ pages, added to the tool's own
          injected count before comparing against the cap above. */}
      <div>
        <div className="flex items-center gap-2">
          <RefreshCw size={12} className="text-slate-400 shrink-0" />
          <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 shrink-0">Existing FAQ pages</span>
          <span className="text-[10px] font-bold text-slate-700">{faqBaseline}</span>
          <button type="button" disabled={faqBaselineBusy} onClick={recalculateFaqBaseline}
            className="text-[10px] font-bold text-blue-600 hover:text-blue-800 disabled:opacity-60 disabled:cursor-not-allowed">
            {faqBaselineBusy ? 'Recalculating…' : 'Recalculate'}
          </button>
        </div>
        {faqBaselineError && <div className="text-[10px] font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2 mt-2">{faqBaselineError}</div>}
      </div>
    </div>
  );
}

// ── Repository tab ────────────────────────────────────────────────────────
// Only repoConnected (boolean) is available from GET /internal/clients —
// repo owner/name/default branch are write-only fields today (set via
// connect-repo, never returned by the list endpoint), and no per-client
// commit/PR aggregation exists anywhere in the backend. So this tab only
// ever shows real state: whether a repo is linked, plus the same
// connect/reconnect form as before — no fabricated branch/commit/PR fields.
function RepositoryTab({ client, onReload }) {
  return (
    <div className="space-y-5">
      <div className="border border-slate-100 rounded-xl px-3.5 py-3 flex items-center justify-between gap-3">
        <div>
          <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
            <GitBranch size={11} /> Repository link
          </span>
          <p className="text-xs font-bold text-slate-800 mt-1">
            {client.repoConnected ? `${client.repoOwner}/${client.repoName}` : 'Not connected'}
          </p>
          {client.repoConnected && (
            <p className="text-[10.5px] font-semibold text-slate-400 mt-0.5">
              {client.githubAppInstallationId
                ? `Auth: GitHub App (installation #${client.githubAppInstallationId})`
                : `Auth: PAT (${client.githubPatEnvVar || 'GITHUB_PAT'})`}
            </p>
          )}
        </div>
        {client.repoConnected && (
          <span className="text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-md border border-slate-200 text-slate-500 bg-slate-50">Git link</span>
        )}
      </div>

      <div>
        <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 block mb-2">
          {client.repoConnected ? 'Reconnect' : 'Connect repository'}
        </span>
        <RepoConnectStep client={client} onConnected={onReload} />
      </div>
    </div>
  );
}

// ── Advanced tab ──────────────────────────────────────────────────────────
function AdvancedTab({ client, onReload, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [hardDeleteOpen, setHardDeleteOpen] = useState(false);
  const [hardDeleteName, setHardDeleteName] = useState('');

  const run = async (action, onSuccess) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onReload();
      onSuccess?.();
    } catch (err) {
      setError(err.message || 'Action failed.');
    } finally {
      setBusy(false);
    }
  };

  const suspend = () => {
    if (!confirm(`Suspend ${client.name}? This immediately blocks all access to their dashboard, MCP tokens, and OAuth grants.`)) return;
    run(() => api.clients.suspend(client.id));
  };
  const reactivate = () => run(() => api.clients.reactivate(client.id));
  const softDelete = () => {
    if (!confirm(`Soft-delete ${client.name}? Data is retained and this is reversible via Reactivate.`)) return;
    run(() => api.clients.softDelete(client.id));
  };
  const hardDelete = () => {
    run(() => api.clients.hardDelete(client.id, hardDeleteName), () => {
      setHardDeleteOpen(false);
      setHardDeleteName('');
      onClose();
    });
  };

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-rose-100 bg-rose-500/[0.03] p-4 space-y-3">
        <p className="text-[10px] font-black uppercase tracking-widest text-rose-700">Danger Zone</p>

        {/* Tenant lifecycle (PLATFORM-ADMIN-DESIGN.md §D, §K Phase 3/3.5).
            The company's own site never reaches an active suspend/delete
            path here — the server rejects COMPANY_SITE_ID unconditionally
            regardless of what this UI shows. */}
        <div className="flex items-center gap-2 flex-wrap">
          {client.status === 'active' && (
            <button type="button" onClick={suspend} disabled={busy}
              className="text-[9px] font-black uppercase tracking-widest px-3 py-2.5 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-100 transition disabled:opacity-60 flex items-center gap-1">
              <PauseCircle size={9} /><span>Suspend</span>
            </button>
          )}
          {(client.status === 'suspended' || client.status === 'soft_deleted') && (
            <button type="button" onClick={reactivate} disabled={busy}
              className="text-[9px] font-black uppercase tracking-widest px-3 py-2.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-100 transition disabled:opacity-60 flex items-center gap-1">
              <PlayCircle size={9} /><span>Reactivate</span>
            </button>
          )}
          {client.status === 'suspended' && (
            <button type="button" onClick={softDelete} disabled={busy}
              className="text-[9px] font-black uppercase tracking-widest px-3 py-2.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-100 transition disabled:opacity-60 flex items-center gap-1">
              <Trash2 size={9} /><span>Soft Delete</span>
            </button>
          )}
          {client.status === 'soft_deleted' && !hardDeleteOpen && (
            <button type="button" onClick={() => setHardDeleteOpen(true)}
              className="text-[9px] font-black uppercase tracking-widest px-3 py-2.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white transition flex items-center gap-1">
              <AlertOctagon size={9} /><span>Hard Delete…</span>
            </button>
          )}
        </div>

        {error && (
          <div className="text-[10px] font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2 leading-relaxed">{error}</div>
        )}

        {client.status === 'soft_deleted' && hardDeleteOpen && (
          <div className="rounded-xl bg-white border border-rose-200 p-4 space-y-3">
            <p className="text-[11px] font-bold text-rose-800 leading-relaxed">
              This permanently and irreversibly deletes <strong>{client.name}</strong> and all its data.
              Type the tenant's exact name to confirm.
            </p>
            <input className={inputCls} value={hardDeleteName} onChange={(e) => setHardDeleteName(e.target.value)} placeholder={client.name} />
            <div className="flex gap-2">
              <button type="button" onClick={hardDelete} disabled={busy || hardDeleteName.trim() !== client.name}
                className="text-[10px] font-black uppercase tracking-wider px-4 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white transition disabled:opacity-40">
                {busy ? 'Deleting…' : 'Permanently Delete'}
              </button>
              <button type="button" onClick={() => { setHardDeleteOpen(false); setHardDeleteName(''); }}
                className="text-[10px] font-black uppercase tracking-wider px-4 py-2.5 rounded-xl bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 transition">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const TABS = [
  { value: 'general', label: 'General' },
  { value: 'integrations', label: 'Integrations' },
  { value: 'ai', label: 'AI Configuration' },
  { value: 'repository', label: 'Repository' },
  { value: 'advanced', label: 'Advanced' },
];

export default function ClientDrawer({ client, owner, isOpen, onClose, onReload, initialTab = 'general' }) {
  const [tab, setTab] = useState(initialTab);

  // Reset to the requested tab whenever a different client's drawer opens.
  const [lastClientId, setLastClientId] = useState(client?.id);
  if (client && client.id !== lastClientId) {
    setLastClientId(client.id);
    if (tab !== initialTab) setTab(initialTab);
  }

  if (!client) return null;

  return (
    <Drawer isOpen={isOpen} onClose={onClose} title={client.name} subtitle={client.websiteDomain || 'no domain configured'} icon={Building} maxWidth="max-w-2xl">
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'general' && <GeneralTab client={client} owner={owner} />}
      {tab === 'integrations' && <IntegrationsTab client={client} onReload={onReload} />}
      {tab === 'ai' && <AiConfigTab client={client} onReload={onReload} />}
      {tab === 'repository' && <RepositoryTab client={client} onReload={onReload} />}
      {tab === 'advanced' && <AdvancedTab client={client} onReload={onReload} onClose={onClose} />}
    </Drawer>
  );
}
