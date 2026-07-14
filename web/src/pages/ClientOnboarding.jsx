import { useEffect, useState } from 'react';
import { api, timeAgo } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';
import SectionHeader from '../components/SectionHeader.jsx';

const inputCls = 'w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#6C63FF]/30 focus:border-[#6C63FF]';
const labelCls = 'block text-xs font-semibold text-slate-600 mb-1';

function Field({ label, hint, ...props }) {
  return (
    <label className="block">
      <span className={labelCls}>{label}</span>
      <input className={inputCls} {...props} />
      {hint && <span className="block text-[11px] text-slate-400 mt-1">{hint}</span>}
    </label>
  );
}

// Step 2 result is a real baseline agent run's output, shown exactly as
// returned — insufficient-data agents named honestly (expected for a
// brand-new property with little history yet), never a placeholder.
function BaselineResult({ result }) {
  const { analysis, healthScore, discovery, ingestion } = result;
  return (
    <div className="mt-4 rounded-xl bg-emerald-50 border border-emerald-100 p-4 space-y-2 fade-up">
      <p className="text-sm font-bold text-emerald-800">Real day-0 baseline captured.</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs text-emerald-900">
        <span>Website health score</span><span className="font-mono font-semibold text-right">{healthScore ?? '—'}/100</span>
        <span>Agents run</span><span className="font-mono font-semibold text-right">{analysis?.ranAgentIds?.length ?? 0}</span>
        <span>Findings so far</span><span className="font-mono font-semibold text-right">{analysis?.findingsCount ?? 0}</span>
        <span>Pages discovered (sitemap)</span><span className="font-mono font-semibold text-right">{discovery?.sitemapCount ?? 0}</span>
        <span>Pages discovered (crawl)</span><span className="font-mono font-semibold text-right">{discovery?.crawlCount ?? 0}</span>
        <span>Days of GSC/GA4 ingested</span><span className="font-mono font-semibold text-right">{ingestion?.reportDate ? 'through ' + ingestion.reportDate : '—'}</span>
      </div>
      <p className="text-[11px] text-emerald-700 leading-relaxed pt-1">
        A brand-new property often has sparse history — low numbers here are real and expected, not an error. This is the fixed reference point every future growth report will measure from.
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
      // A failed connect attempt can still have saved real gsc_property/
      // ga4_property_id (updateSiteConnection succeeds before ingestion is
      // attempted) — refresh the list either way so it never shows stale
      // "awaiting access" for a site whose properties actually did save.
      onConnected?.();
    }
  };

  if (state === 'done' && result) return <BaselineResult result={result} />;

  return (
    <form onSubmit={submit} className="space-y-3 mt-3">
      <div className="rounded-lg bg-amber-50 border border-amber-100 px-3 py-2.5 text-[12px] text-amber-800 leading-relaxed">
        Before continuing: add this platform's Google account as a user on <strong>{client.name}</strong>'s Search
        Console property and grant it Google Analytics 4 access. This is a real step the client (or their webmaster)
        must do — it can't be automated from here, and connecting will fail honestly if it hasn't happened yet.
      </div>
      <Field label="GSC property" value={gscProperty} onChange={(e) => setGscProperty(e.target.value)}
        placeholder="sc-domain:example.com" hint="Exact string from Search Console → Settings → Property." required />
      <Field label="GA4 property ID" value={ga4PropertyId} onChange={(e) => setGa4PropertyId(e.target.value)}
        placeholder="123456789" hint="Numeric ID from GA4 Admin → Property Settings." required />
      <Field label="Report email (optional)" type="email" value={reportEmailTo} onChange={(e) => setReportEmailTo(e.target.value)}
        placeholder="client@example.com" />
      {state === 'error' && <p className="text-xs text-rose-600 leading-relaxed">{error}</p>}
      <button type="submit" disabled={state === 'running'}
        className="text-xs font-semibold px-4 py-2 rounded-lg text-white disabled:opacity-60 transition"
        style={{ background: '#6C63FF' }}>
        {state === 'running' ? 'Connecting and running real baseline… (~30-60s)' : 'Connect & run day-0 baseline'}
      </button>
    </form>
  );
}

const inputMonoCls = 'w-full text-xs font-mono border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#6C63FF]/30 focus:border-[#6C63FF]';

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

// Optional, separate from GSC/GA4 — only needed for clients using the
// Action Center's "apply as a real PR" flow. A raw JSON textarea, not a
// structured editor — matches url_file_map's real current shape exactly
// (server/implementers/lib/url-file-map.js) rather than inventing a new
// format the backend doesn't actually use.
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
        setError('url_file_map is not valid JSON — check for a trailing comma or unmatched bracket.');
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
    return <p className="mt-3 text-sm font-semibold text-emerald-700">Repo connected. The Action Center can now try opening real PRs for this client.</p>;
  }

  return (
    <form onSubmit={submit} className="space-y-3 mt-3">
      <div className="rounded-lg bg-amber-50 border border-amber-100 px-3 py-2.5 text-[12px] text-amber-800 leading-relaxed">
        The GitHub token named below (an env var on this server, not typed in here) needs real write access to this
        repo. <code className="text-[11px]">url_file_map</code> is a real, hand-authored mapping — no auto-discovery
        exists yet, so a wrong or missing entry fails honestly rather than guessing a file to write to.
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Repo owner" value={repoOwner} onChange={(e) => setRepoOwner(e.target.value)} placeholder="acme-inc" required />
        <Field label="Repo name" value={repoName} onChange={(e) => setRepoName(e.target.value)} placeholder="acme-website" required />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Default branch" value={repoDefaultBranch} onChange={(e) => setRepoDefaultBranch(e.target.value)} placeholder="main" />
        <Field label="Tech stack" value={techStack} onChange={(e) => setTechStack(e.target.value)} placeholder="e.g. astro, nextjs, eleventy-nunjucks"
          hint="Documentation only today — not yet used to change merge behavior." />
      </div>
      <Field label="GitHub PAT env var name" value={githubPatEnvVar} onChange={(e) => setGithubPatEnvVar(e.target.value)}
        placeholder="GITHUB_PAT" hint="The name of the server env var holding this client's token — set it there separately, never pasted into this form." />
      <label className="block">
        <span className={labelCls}>url_file_map (JSON, optional — leave blank to fill in later)</span>
        <textarea className={inputMonoCls} rows={10} value={urlFileMapText} onChange={(e) => setUrlFileMapText(e.target.value)}
          placeholder={EXAMPLE_URL_FILE_MAP} />
      </label>
      {state === 'error' && <p className="text-xs text-rose-600 leading-relaxed">{error}</p>}
      <button type="submit" disabled={state === 'running'}
        className="text-xs font-semibold px-4 py-2 rounded-lg text-white disabled:opacity-60 transition"
        style={{ background: '#6C63FF' }}>
        {state === 'running' ? 'Saving…' : 'Save repo config'}
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
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Client name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Corp" required />
        <Field label="Website domain" value={websiteDomain} onChange={(e) => setWebsiteDomain(e.target.value)} placeholder="acme.com" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Asia/Kolkata" />
        <div />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="First login — email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="client@acme.com" required />
        <Field label="First login — password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" required minLength={8} />
      </div>
      {state === 'error' && <p className="text-xs text-rose-600">{error}</p>}
      <button type="submit" disabled={state === 'running'}
        className="text-xs font-semibold px-4 py-2 rounded-lg text-white disabled:opacity-60 transition"
        style={{ background: '#6C63FF' }}>
        {state === 'running' ? 'Creating…' : 'Create client'}
      </button>
    </form>
  );
}

const STATUS = {
  connected: { label: 'Connected · baselined', color: '#16A34A', bg: '#f0fdf4' },
  baselinePending: { label: 'Connected · no baseline yet', color: '#f59e0b', bg: '#fffbeb' },
  pending: { label: 'Awaiting GSC/GA4 access', color: '#f59e0b', bg: '#fffbeb' },
};

export default function ClientOnboarding() {
  const [clients, setClients] = useState(null); // null = loading
  const [showNewForm, setShowNewForm] = useState(false);
  const [connectingClient, setConnectingClient] = useState(null);
  const [connectingRepoClient, setConnectingRepoClient] = useState(null);
  // Retry-baseline is a single button, not a form — keyed by client id so
  // multiple rows can be retried independently without a shared modal state.
  const [retryState, setRetryState] = useState({}); // {[clientId]: 'running'|'done'|'error'}
  const [retryResult, setRetryResult] = useState({}); // {[clientId]: result | {error}}

  // Real, pending prospective-client submissions from the public "Request
  // Access" form (Login.jsx) — never a real account until Approve below.
  const [requests, setRequests] = useState(null); // null = loading
  // Same per-row keyed-state shape as retryState/retryResult above.
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
      onCreated(site); // same flow as manually creating a client — opens Step 2 Connect
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

  const onCreated = (site) => {
    setShowNewForm(false);
    setConnectingClient({ id: site.id, name: site.name });
    load();
  };

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      <PageHeader title="Client Onboarding" icon="🏢"
        subtitle="Register a new client, connect their real GSC/GA4 access, and capture a real day-0 baseline — the fixed point every future growth report measures from."
        right={
          <button type="button" onClick={() => setShowNewForm((s) => !s)}
            className="text-xs font-semibold px-3.5 py-2 rounded-lg text-white transition" style={{ background: '#6C63FF' }}>
            {showNewForm ? 'Cancel' : '+ New client'}
          </button>
        } />

      {/* Real, pending requests from the public "Request Access" form
          (Login.jsx) — never a real account until reviewed here. Approve
          reuses the exact same createClientSite+createUser sequence as
          "New client" below, just sourced from the request instead of a
          staff-typed form, and drops straight into the same Step 2 Connect
          flow via onCreated. */}
      <div>
        <SectionHeader title="Pending Signup Requests" count={requests ? `${requests.length} pending` : null}
          desc="Real submissions from the landing page's Request Access form — nothing here is a real account until you approve it." />
        {requests === null ? (
          <div className="card p-8 text-center text-sm text-slate-400">Loading…</div>
        ) : requests.length === 0 ? (
          <div className="card p-8 text-center text-sm text-slate-400">No pending requests.</div>
        ) : (
          <div className="card divide-y divide-slate-50">
            {requests.map((r) => {
              const state = reviewState[r.id];
              const busy = state === 'approving' || state === 'rejecting';
              return (
                <div key={r.id} className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-slate-800 truncate">{r.companyName}</p>
                      <p className="text-xs text-slate-400 truncate">
                        {r.contactEmail}{r.websiteDomain && ` · ${r.websiteDomain}`} · requested {timeAgo(r.createdAt)}
                      </p>
                      {r.message && <p className="text-xs text-slate-500 mt-1 leading-relaxed">"{r.message}"</p>}
                    </div>
                    <button type="button" onClick={() => approveRequest(r)} disabled={busy}
                      className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition shrink-0 disabled:opacity-60">
                      {state === 'approving' ? 'Approving…' : 'Approve'}
                    </button>
                    <button type="button" onClick={() => rejectRequest(r)} disabled={busy}
                      className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-slate-50 text-slate-500 hover:bg-slate-100 transition shrink-0 disabled:opacity-60">
                      {state === 'rejecting' ? 'Rejecting…' : 'Reject'}
                    </button>
                  </div>
                  {reviewError[r.id] && <p className="mt-2 text-xs text-rose-600 leading-relaxed">{reviewError[r.id]}</p>}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showNewForm && (
        <div className="card p-5 fade-up">
          <SectionHeader title="Step 1 — Create client" desc="Creates the site and its first login. GSC/GA4 stay unconnected until step 2 — that's a real, separate step, not hidden." />
          <NewClientForm onCreated={onCreated} />
        </div>
      )}

      {connectingClient && (
        <div className="card p-5 fade-up">
          <SectionHeader title={`Step 2 — Connect ${connectingClient.name}`} desc="Real GSC/GA4 property connection, then an immediate real baseline run — not next week's cron." />
          <ConnectStep client={connectingClient} onConnected={load} />
        </div>
      )}

      {connectingRepoClient && (
        <div className="card p-5 fade-up">
          <SectionHeader title={`Step 3 (optional) — Connect ${connectingRepoClient.name}'s GitHub repo`}
            desc="Only needed for clients using the Action Center's real PR-fix flow. Independent of GSC/GA4 — can be done anytime, including later." />
          <RepoConnectStep client={connectingRepoClient} onConnected={load} />
        </div>
      )}

      <div>
        <SectionHeader title="All clients" count={clients ? `${clients.length} total` : null} />
        {clients === null ? (
          <div className="card p-8 text-center text-sm text-slate-400">Loading…</div>
        ) : clients.length === 0 ? (
          <div className="card p-8 text-center text-sm text-slate-400">No clients yet — create one above.</div>
        ) : (
          <div className="card divide-y divide-slate-50">
            {clients.map((c) => {
              // Three real, distinct states — `connected` (GSC/GA4 saved)
              // and `baselined` (a real baseline run actually completed and
              // got stamped) are independent signals, not one collapsed
              // boolean, so "properties saved but the audit never actually
              // ran" (both real sites' history) is visible, not hidden.
              const s = !c.connected ? STATUS.pending : c.baselined ? STATUS.connected : STATUS.baselinePending;
              const rState = retryState[c.id];
              const rResult = retryResult[c.id];
              return (
                <div key={c.id} className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-slate-800 truncate">{c.name}</p>
                      <p className="text-xs text-slate-400 truncate">
                        {c.websiteDomain || 'no domain set'}
                        {c.onboardedAt && ` · onboarded ${timeAgo(c.onboardedAt)}`}
                      </p>
                    </div>
                    <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded-full shrink-0" style={{ color: s.color, background: s.bg }}>
                      {s.label}
                    </span>
                    {c.repoConnected && (
                      <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded-full shrink-0 text-slate-500 bg-slate-100">
                        Repo connected
                      </span>
                    )}
                    {!c.connected && (
                      <button type="button" onClick={() => setConnectingClient({ id: c.id, name: c.name })}
                        className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-indigo-50 text-indigo-600 hover:bg-indigo-100 transition shrink-0">
                        Connect
                      </button>
                    )}
                    {c.connected && !c.baselined && (
                      <button type="button" onClick={() => retryBaseline(c)} disabled={rState === 'running'}
                        className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-amber-50 text-amber-700 hover:bg-amber-100 transition shrink-0 disabled:opacity-60">
                        {rState === 'running' ? 'Running real baseline…' : 'Retry baseline'}
                      </button>
                    )}
                    <button type="button" onClick={() => setConnectingRepoClient({ id: c.id, name: c.name })}
                      className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-slate-50 text-slate-500 hover:bg-slate-100 transition shrink-0">
                      {c.repoConnected ? 'Edit repo' : 'Connect repo'}
                    </button>
                  </div>
                  {rState === 'done' && rResult && !rResult.error && <BaselineResult result={rResult} />}
                  {rState === 'error' && rResult?.error && (
                    <p className="mt-3 text-xs text-rose-600 leading-relaxed">{rResult.error}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
