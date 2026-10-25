import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, timeAgo } from '../api.js';
import {
  Building, Globe, Clock, CheckCircle2, AlertTriangle, GitBranch,
  RefreshCw, ShieldCheck, PauseCircle, PlayCircle,
  Trash2, AlertOctagon, HelpCircle, DollarSign, User, Bot, Palette, ArrowRight, Plus,
} from 'lucide-react';
import Drawer from './Drawer.jsx';
import Tabs from './Tabs.jsx';
import Avatar from './Avatar.jsx';
import Badge from './Badge.jsx';
import Button from './Button.jsx';
import Field from './Field.jsx';
import Select from './Select.jsx';
import SegmentedTabs from './SegmentedTabs.jsx';
import KpiStrip from './layout/KpiStrip.jsx';
import ClientBusinessValuesPanel from './ClientBusinessValuesPanel.jsx';

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
  connected: { label: 'Active baseline', tone: 'green' },
  baselinePending: { label: 'Baseline pending', tone: 'amber' },
  pending: { label: 'Awaiting integrations', tone: 'amber' },
};

const LIFECYCLE_PILLS = {
  suspended: { label: 'Suspended', tone: 'amber' },
  soft_deleted: { label: 'Soft-deleted', tone: 'red' },
};

const ringStyle = { boxShadow: 'var(--ring)' };

// ── Shared look for everything in the drawer ─────────────────────────────

// Inline message: error / warning / success / info. Same colours the rest of
// the app uses for these (see TeamCard's invite error + info note).
const NOTICE_TONES = {
  error: 'bg-[#fdecec] text-[#b42318]',
  warn: 'bg-[#fdf3e1] text-[#8a5300]',
  success: 'bg-[var(--green-tint)] text-[var(--green)]',
  info: 'bg-muted text-text',
};

function Notice({ tone = 'info', icon: Icon, className = '', children }) {
  return (
    <div role={tone === 'error' ? 'alert' : undefined}
      className={`flex items-start gap-2.5 rounded-control px-3 py-2.5 text-[13px] leading-5 ${NOTICE_TONES[tone]} ${className}`.trim()}>
      {Icon && <Icon size={15} className="shrink-0 mt-0.5" aria-hidden />}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// A titled group inside a tab: heading (icon + title) with an optional control
// on the right, then its content. Groups after the first are divided by a
// hairline, the way the settings cards separate their rows.
function Section({ icon: Icon, title, control, children }) {
  return (
    <section className="border-t border-border pt-5 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h3 className="flex items-center gap-2 text-[13px] font-medium text-fg">
          {Icon && <Icon size={14} className="text-faint shrink-0" aria-hidden />}
          {title}
        </h3>
        {control && <div className="flex items-center gap-2">{control}</div>}
      </div>
      {children && <div className="mt-2.5 space-y-2.5">{children}</div>}
    </section>
  );
}

// A small read-only fact: label (icon) over value, in a ringed tile.
function InfoTile({ icon: Icon, label, children, aside, wrap = false, className = '' }) {
  return (
    <div className={`rounded-control px-3.5 py-3 flex items-center justify-between gap-3 min-w-0 ${className}`.trim()} style={ringStyle}>
      <div className="min-w-0">
        <span className="text-xs text-faint flex items-center gap-1.5">
          {Icon && <Icon size={12} aria-hidden />} {label}
        </span>
        <div className={`text-[13px] font-medium text-fg mt-1 ${wrap ? 'break-words' : 'truncate'}`}>{children}</div>
      </div>
      {aside}
    </div>
  );
}

// Two-state switch built from the app's own segmented `.toggle` (the same
// control Overview's date presets use), with a disabled state.
function OnOffToggle({ on, onChange, disabled, offLabel = 'Off', onLabel = 'On', ariaLabel }) {
  const btn = 'disabled:opacity-60 disabled:cursor-not-allowed';
  return (
    <div className="toggle" role="group" aria-label={ariaLabel}>
      <button type="button" disabled={disabled} className={`${btn} ${!on ? 'is-on' : ''}`.trim()} aria-pressed={!on}
        onClick={() => { if (on) onChange(false); }}>{offLabel}</button>
      <button type="button" disabled={disabled} className={`${btn} ${on ? 'is-on' : ''}`.trim()} aria-pressed={on}
        onClick={() => { if (!on) onChange(true); }}>{onLabel}</button>
    </div>
  );
}

function BaselineResult({ result }) {
  const { analysis, healthScore, discovery, ingestion } = result;
  return (
    <div className="mt-4 rounded-card overflow-hidden animate-fade-in" style={ringStyle}>
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <ShieldCheck size={15} className="text-[var(--green)]" aria-hidden />
        <p className="text-[13px] font-medium text-fg">Baseline diagnostic recorded</p>
      </div>
      <KpiStrip bare cols={3} items={[
        { label: 'Website health score', value: `${healthScore ?? '—'}/100` },
        { label: 'Agents activated', value: analysis?.ranAgentIds?.length ?? 0 },
        { label: 'Findings logged', value: analysis?.findingsCount ?? 0 },
        { label: 'Sitemap discoveries', value: discovery?.sitemapCount ?? 0 },
        { label: 'Crawled pages', value: discovery?.crawlCount ?? 0 },
        { label: 'Ingested through', value: ingestion?.reportDate || '—' },
      ]} />
      <p className="px-4 py-3 border-t border-border text-xs leading-4 text-faint">
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
      <Notice tone="warn" icon={AlertTriangle}>
        Grant Google Access: Add the platform service account as a user on GSC and GA4 for <strong>{client.name}</strong> before connecting. The connection will perform real data ingestion and validation immediately.
      </Notice>
      <Field label="GSC Property" value={gscProperty} onChange={(e) => setGscProperty(e.target.value)}
        placeholder="sc-domain:example.com" hint="Exact property ID from Search Console Settings Dashboard." required />
      <Field label="GA4 Property ID" value={ga4PropertyId} onChange={(e) => setGa4PropertyId(e.target.value)}
        placeholder="123456789" hint="Numeric GA4 property reference ID." required />
      <Field label="Report Email Destination (Optional)" type="email" value={reportEmailTo} onChange={(e) => setReportEmailTo(e.target.value)}
        placeholder="client@example.com" />
      {state === 'error' && <Notice tone="error">{error}</Notice>}
      <Button type="submit" variant="primary" disabled={state === 'running'}>
        {state === 'running' ? 'Connecting and fetching real GSC/GA4 baseline…' : 'Connect & Fetch Baseline'}
      </Button>
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
      <Notice tone="success" icon={CheckCircle2}>
        GitHub repository connected successfully. Ready to deploy live PRs.
      </Notice>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Notice tone="info" icon={GitBranch}>
        Git Setup: The Action Center relies on a hand-authored <code>url_file_map</code> to translate website routes to real file paths in your repository.
      </Notice>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Repo Owner" value={repoOwner} onChange={(e) => setRepoOwner(e.target.value)} placeholder="acme-inc" required />
        <Field label="Repo Name" value={repoName} onChange={(e) => setRepoName(e.target.value)} placeholder="acme-website" required />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Default Branch" value={repoDefaultBranch} onChange={(e) => setRepoDefaultBranch(e.target.value)} placeholder="main" />
        <Field label="Tech Stack" value={techStack} onChange={(e) => setTechStack(e.target.value)} placeholder="e.g. astro, nextjs, nunjucks" />
      </div>
      <Field label="GitHub PAT Env Var Name" value={githubPatEnvVar} onChange={(e) => setGithubPatEnvVar(e.target.value)}
        placeholder="GITHUB_PAT" hint="Server-side environment variable key naming the GitHub access token." />
      <Field label="GitHub App Installation ID (optional)" value={githubAppInstallationId} onChange={(e) => setGithubAppInstallationId(e.target.value)}
        placeholder="e.g. 64837201"
        hint="Overrides the PAT above entirely once set — tokens are minted per-installation instead of shared. Usually filled in automatically once the client installs the GitHub App; leave blank to keep using the PAT, or clear it to move back." />
      <Field as="textarea" label="url_file_map (JSON, optional)" className="[&_textarea]:font-mono [&_textarea]:text-xs" rows={8}
        value={urlFileMapText} onChange={(e) => setUrlFileMapText(e.target.value)} placeholder={EXAMPLE_URL_FILE_MAP} />
      {state === 'error' && <Notice tone="error">{error}</Notice>}
      <Button type="submit" variant="primary" disabled={state === 'running'}>
        {state === 'running' ? 'Connecting Repository…' : 'Save Repo Configuration'}
      </Button>
    </form>
  );
}

function StatusPill({ client }) {
  const s = !client.connected ? STATUS_PILLS.pending : client.baselined ? STATUS_PILLS.connected : STATUS_PILLS.baselinePending;
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

// ── General tab ──────────────────────────────────────────────────────────
function GeneralTab({ client, owner }) {
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3.5">
        <Avatar email={client.name} size="lg" />
        <div className="min-w-0">
          <p className="text-[15px] font-semibold text-fg truncate">{client.name}</p>
          <p className="text-xs text-faint truncate">{client.websiteDomain || 'no domain configured'}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <InfoTile icon={Globe} label="Website">{client.websiteDomain || '—'}</InfoTile>
        <InfoTile icon={User} label="Owner">{owner ? owner.email : '—'}</InfoTile>
        <InfoTile icon={Clock} label="Timezone">{client.timezone || '—'}</InfoTile>
        <InfoTile icon={Clock} label="Created">
          {client.onboardedAt ? timeAgo(client.onboardedAt) : (client.createdAt ? timeAgo(client.createdAt) : '—')}
        </InfoTile>
      </div>

      <div>
        <span className="text-xs font-medium text-fg block mb-1.5">Status</span>
        <div className="flex items-center gap-1.5 flex-wrap">
          {LIFECYCLE_PILLS[client.status] && (
            <Badge tone={LIFECYCLE_PILLS[client.status].tone}>{LIFECYCLE_PILLS[client.status].label}</Badge>
          )}
          <StatusPill client={client} />
          {client.repoConnected && <Badge tone="outline"><GitBranch size={11} />Git link</Badge>}
        </div>
      </div>

      <p className="text-xs leading-4 text-faint border-t border-border pt-4">
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
      <InfoTile icon={ShieldCheck} label="OAuth status" wrap aside={<StatusPill client={client} />}>
        {!client.connected ? 'Not connected' : client.baselined ? 'Connected — active baseline' : 'Connected — baseline pending'}
      </InfoTile>

      {!client.connected && !connecting && (
        <Button variant="light" onClick={() => setConnecting(true)}>Connect API</Button>
      )}
      {!client.connected && connecting && (
        <ConnectStep client={client} onConnected={onReload} />
      )}

      {client.connected && !client.baselined && (
        <div>
          <Button variant="light" onClick={retryBaseline} disabled={retrying}>
            <RefreshCw size={14} className={retrying ? 'animate-spin' : ''} />
            <span>{retrying ? 'Syncing…' : 'Sync now (Retry Ingest)'}</span>
          </Button>
          {retryError && <Notice tone="error" className="mt-2">{retryError}</Notice>}
          {retryResult && !retryResult.error && <BaselineResult result={retryResult} />}
        </div>
      )}

      <Section icon={GitBranch} title="Repository connection">
        <p className="text-[13px] font-medium text-fg">{client.repoConnected ? 'Connected' : 'Not connected'}</p>
        <p className="text-xs text-faint">Manage repository details in the Repository tab.</p>
      </Section>

      {/* GA4/Meta Pixel install target — what the Action Center's
          analytics-install generator drafts a script for. Distinct from
          "GA4 Property ID" above (the reporting ingestion source). */}
      <Section icon={Globe} title="Analytics install (GA4 / Meta Pixel)">
        <Field label="GA4 Measurement ID" value={ga4MeasurementId}
          onChange={(e) => { setGa4MeasurementId(e.target.value); setAnalyticsIdsSaved(false); }}
          placeholder="G-XXXXXXXXXX" hint="Used for the on-site gtag install script, not the reporting property above." />
        <Field label="Meta (Facebook) Pixel ID" value={facebookPixelId}
          onChange={(e) => { setFacebookPixelId(e.target.value); setAnalyticsIdsSaved(false); }}
          placeholder="123456789012345" hint="Numeric Pixel ID from Meta Events Manager." />
        <div className="pt-1">
          <Button variant="light" onClick={saveAnalyticsIds} disabled={analyticsIdsSaving}>
            {analyticsIdsSaving ? 'Saving…' : 'Save Analytics IDs'}
          </Button>
        </div>
        {analyticsIdsSaved && !analyticsIdsError && (
          <p className="text-[13px] text-[var(--green)]">Saved — the next analytics-install draft will use this.</p>
        )}
        {analyticsIdsError && <Notice tone="error">{analyticsIdsError}</Notice>}
      </Section>
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
      <Section icon={Bot} title="Autonomous fixes" control={(
        <>
          {autoSaving && <span className="text-xs text-faint">Saving…</span>}
          <OnOffToggle ariaLabel="Autonomous fixes" on={autoOn} disabled={autoSaving || !client.repoConnected}
            onChange={(next) => saveAutoRemediation(next, autoLimit)} />
          {autoOn && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-faint">Max/day</span>
              <div className="fld w-20">
                <input
                  type="number" min="0" value={autoLimit} disabled={autoSaving} aria-label="Max fixes per day"
                  onChange={(e) => setAutoLimit(Number(e.target.value))}
                  onBlur={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isInteger(n) && n >= 0 && n !== (client.autoRemediationDailyLimit ?? 30)) saveAutoRemediation(autoOn, n);
                  }}
                  className="disabled:opacity-60"
                />
              </div>
            </div>
          )}
        </>
      )}>
        <p className="text-[13px] leading-5 text-text">
          {!client.repoConnected
            ? 'No GitHub repository is connected for this site, so autonomous fixes would have nowhere to open a pull request. Connect a repo first.'
            : autoOn
              ? `Every morning this site's safe-tier fixes are drafted, validated and pushed as pull requests — up to ${autoLimit} a day — without anyone clicking anything. A human still reviews and merges every PR; nothing is ever merged automatically.`
              : 'This site\'s agents will keep finding and recommending fixes, but nothing ships until someone acts on each one in the Action Center.'}
        </p>
        {autoError && <Notice tone="error">{autoError}</Notice>}
        {/* The design-integrity gate: the server now REFUSES to enable
            autonomous fixes for a site whose design was never reviewed (or
            was re-derived since it was approved) — see
            validateAutoRemediationRequest, routes/clients.js. Clicking On
            above without this done first fails with exactly that message
            in autoError above; this link is the actual next step. */}
        <button
          type="button"
          onClick={() => navigate(`/clients/${client.id}/design-review`)}
          className="inline-flex items-center gap-1.5 text-[13px] font-medium text-primary hover:underline"
        >
          <Palette size={13} aria-hidden /> Review this site's design <ArrowRight size={13} aria-hidden />
        </button>
      </Section>

      {/* OAuth "Connect" ceiling — the max permission_level this client's
          OAuth grants (server/routes/oauth-consent.js) can ever reach.
          'admin' deliberately isn't an option; see OAUTH_POLICY_OPTIONS. */}
      <Section icon={ShieldCheck} title="OAuth ceiling" control={(
        <div className="fld w-40">
          <select value={oauthLevel} disabled={oauthSaving} aria-label="OAuth ceiling" onChange={(e) => changeOauthLevel(e.target.value)}
            className="disabled:opacity-60">
            {OAUTH_POLICY_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
        </div>
      )}>
        {oauthError && <Notice tone="error">{oauthError}</Notice>}
      </Section>

      {/* Sitewide visible-FAQ cap. */}
      <Section icon={HelpCircle} title="Visible FAQ cap" control={(
        <div className="fld w-20">
          <input type="number" min={0} step={1} value={faqCap} disabled={faqCapSaving} aria-label="Visible FAQ cap"
            onChange={(e) => changeFaqCap(Number(e.target.value))} className="disabled:opacity-60" />
        </div>
      )}>
        {faqCapError && <Notice tone="error">{faqCapError}</Notice>}
      </Section>

      {/* Real $ inputs for the Analyst dashboard's Expected Business Impact projections. */}
      <Section icon={DollarSign} title="Business values" control={(
        <Button variant="light" size="sm" onClick={() => setBusinessValuesOpen((o) => !o)}>
          {businessValuesOpen ? 'Hide' : 'Configure…'}
        </Button>
      )}>
        {businessValuesOpen && <ClientBusinessValuesPanel clientId={client.id} />}
      </Section>

      {/* Organic (pre-existing) visible FAQ pages, added to the tool's own
          injected count before comparing against the cap above. */}
      <Section icon={RefreshCw} title="Existing FAQ pages" control={(
        <>
          <span className="text-[13px] font-medium text-fg tnum">{faqBaseline}</span>
          <Button variant="light" size="sm" disabled={faqBaselineBusy} onClick={recalculateFaqBaseline}>
            {faqBaselineBusy ? 'Recalculating…' : 'Recalculate'}
          </Button>
        </>
      )}>
        {faqBaselineError && <Notice tone="error">{faqBaselineError}</Notice>}
      </Section>
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
      <InfoTile icon={GitBranch} label="Repository link" wrap
        aside={client.repoConnected ? <Badge tone="outline" className="shrink-0"><GitBranch size={11} />Git link</Badge> : null}>
        {client.repoConnected ? `${client.repoOwner}/${client.repoName}` : 'Not connected'}
        {client.repoConnected && (
          <span className="block text-xs font-normal text-faint mt-0.5 break-words">
            {client.githubAppInstallationId
              ? `Auth: GitHub App (installation #${client.githubAppInstallationId})`
              : `Auth: PAT (${client.githubPatEnvVar || 'GITHUB_PAT'})`}
          </span>
        )}
      </InfoTile>

      <div>
        <span className="text-[13px] font-medium text-fg block mb-3">
          {client.repoConnected ? 'Reconnect' : 'Connect repository'}
        </span>
        <RepoConnectStep client={client} onConnected={onReload} />
      </div>
    </div>
  );
}

// Destructive actions keep their meaning by colour: amber = reversible hold,
// green = restore, red = delete.
const AMBER_BTN = 'text-[#8a5300]';
const GREEN_BTN = 'text-[var(--green)]';
const RED_BTN = 'text-[#b42318]';
const RED_SOLID_BTN = 'bg-[#b42318]! hover:bg-[#912018]! text-white! disabled:opacity-40';

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
      <div className="rounded-card p-4 space-y-3 bg-[#fdecec]/40" style={{ boxShadow: '0 0 0 1px #f3c9c5' }}>
        <h3 className="flex items-center gap-2 text-[13px] font-medium text-[#b42318]">
          <AlertOctagon size={14} aria-hidden /> Danger Zone
        </h3>

        {/* Tenant lifecycle (PLATFORM-ADMIN-DESIGN.md §D, §K Phase 3/3.5).
            The company's own site never reaches an active suspend/delete
            path here — the server rejects COMPANY_SITE_ID unconditionally
            regardless of what this UI shows. */}
        <div className="flex items-center gap-2 flex-wrap">
          {client.status === 'active' && (
            <Button variant="light" className={AMBER_BTN} onClick={suspend} disabled={busy}>
              <PauseCircle size={14} /><span>Suspend</span>
            </Button>
          )}
          {(client.status === 'suspended' || client.status === 'soft_deleted') && (
            <Button variant="light" className={GREEN_BTN} onClick={reactivate} disabled={busy}>
              <PlayCircle size={14} /><span>Reactivate</span>
            </Button>
          )}
          {client.status === 'suspended' && (
            <Button variant="light" className={RED_BTN} onClick={softDelete} disabled={busy}>
              <Trash2 size={14} /><span>Soft Delete</span>
            </Button>
          )}
          {client.status === 'soft_deleted' && !hardDeleteOpen && (
            <Button variant="dark" className={RED_SOLID_BTN} onClick={() => setHardDeleteOpen(true)}>
              <AlertOctagon size={14} /><span>Hard Delete…</span>
            </Button>
          )}
        </div>

        {error && <Notice tone="error">{error}</Notice>}

        {client.status === 'soft_deleted' && hardDeleteOpen && (
          <div className="rounded-control bg-white p-4 space-y-3" style={{ boxShadow: '0 0 0 1px #f3c9c5' }}>
            <p className="text-[13px] leading-5 text-[#b42318]">
              This permanently and irreversibly deletes <strong>{client.name}</strong> and all its data.
              Type the tenant's exact name to confirm.
            </p>
            <Field value={hardDeleteName} onChange={(e) => setHardDeleteName(e.target.value)} placeholder={client.name} aria-label="Tenant name" />
            <div className="flex gap-2">
              <Button variant="dark" className={RED_SOLID_BTN} onClick={hardDelete} disabled={busy || hardDeleteName.trim() !== client.name}>
                {busy ? 'Deleting…' : 'Permanently Delete'}
              </Button>
              <Button variant="light" onClick={() => { setHardDeleteOpen(false); setHardDeleteName(''); }}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Product Growth tab ───────────────────────────────────────────────────
// Configures server/store/product-growth-config.js — markets/industries/ICP
// signals are free-text lists (comma-separated in the UI, stored as JSON
// arrays), and conversionEvent is a plain string so a future product with a
// different funnel (trial, signup, purchase...) isn't forced into
// "booked_demo". None of this reads or writes anything Zenly-specific.
function csvToList(s) {
  return s.split(',').map((v) => v.trim()).filter(Boolean);
}

function ProductGrowthTab({ client }) {
  const [config, setConfig] = useState(null); // null = loading
  const [conversionEvent, setConversionEvent] = useState('');
  const [markets, setMarkets] = useState('');
  const [industries, setIndustries] = useState('');
  const [icpSignals, setIcpSignals] = useState('');
  const [competitorSignals, setCompetitorSignals] = useState('');
  const [outreachEnabled, setOutreachEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const [prospectDiscoveryEnabled, setProspectDiscoveryEnabled] = useState(false);
  const [discoveryToggling, setDiscoveryToggling] = useState(false);
  const [crmToken, setCrmToken] = useState(null);
  const [issuingToken, setIssuingToken] = useState(false);

  const reload = () => api.clients.productGrowthConfig.get(client.id).then((c) => {
    setConfig(c);
    setConversionEvent(c.conversionEvent || '');
    setMarkets((c.markets || []).join(', '));
    setIndustries((c.industries || []).join(', '));
    setIcpSignals((c.icpSignals || []).join(', '));
    setCompetitorSignals((c.competitor_signals || []).join(', '));
    setOutreachEnabled(!!c.outreachEnabled);
    setProspectDiscoveryEnabled(!!c.prospect_discovery_enabled);
    setCrmToken(c.crm_webhook_token || null);
  }).catch(() => setConfig({}));

  useEffect(() => { reload(); }, [client.id]);

  const toggleProspectDiscovery = async (next) => {
    setDiscoveryToggling(true);
    setProspectDiscoveryEnabled(next);
    try {
      await api.clients.productGrowthConfig.setProspectDiscovery(client.id, next);
    } catch {
      setProspectDiscoveryEnabled(!next);
    } finally {
      setDiscoveryToggling(false);
    }
  };

  const issueCrmToken = async () => {
    setIssuingToken(true);
    try {
      const { crmWebhookToken } = await api.clients.productGrowthConfig.issueCrmWebhookToken(client.id);
      setCrmToken(crmWebhookToken);
    } finally {
      setIssuingToken(false);
    }
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const updated = await api.clients.productGrowthConfig.save(client.id, {
        conversionEvent: conversionEvent.trim() || null,
        markets: csvToList(markets),
        industries: csvToList(industries),
        icpSignals: csvToList(icpSignals),
        competitorSignals: csvToList(competitorSignals),
        outreachEnabled,
      });
      setConfig(updated);
    } catch (err) {
      setError(err.message || 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  if (config === null) return <p className="text-[13px] text-faint py-4">Loading…</p>;

  return (
    <form onSubmit={save} className="space-y-4">
      <p className="text-xs leading-5 text-faint">
        This property runs the visibility + demand-generation agent set instead of the traffic-history agents (see
        Universal Product Growth mode). Nothing here is required for those agents to start finding real issues —
        it only configures the demand-generation layer: which conversion event counts as success, and which
        prospects are worth surfacing.
      </p>

      <Field label="Primary conversion event" value={conversionEvent} onChange={(e) => setConversionEvent(e.target.value)}
        placeholder="e.g. booked_demo, trial, signup, purchase" />

      <Field label="Target markets" value={markets} onChange={(e) => setMarkets(e.target.value)}
        placeholder="Comma-separated, e.g. US, UK, South Asia" />

      <Field label="Target industries" value={industries} onChange={(e) => setIndustries(e.target.value)}
        placeholder="Comma-separated, e.g. Salons, Dental clinics" />

      <Field label="ICP qualification signals" value={icpSignals} onChange={(e) => setIcpSignals(e.target.value)}
        placeholder="Comma-separated, e.g. 2+ locations, 5+ staff"
        hint="Configurable per product — never a hardcoded rule. Used only to qualify prospects with real evidence; a prospect the platform can't back with evidence is reported as insufficient-data, never guessed." />

      <Field label="Competitor signal phrases" value={competitorSignals} onChange={(e) => setCompetitorSignals(e.target.value)}
        placeholder="Comma-separated, e.g. booking software, salon management platform"
        hint={'Language a same-category seller would use about itself. When a "see it live" trial signup\'s own real homepage contains one of these — or matches an already-tracked real competitor\'s domain — it\'s flagged as a competitor suspect on the Demand page, never auto-blocked.'} />

      <div>
        <label className="flex items-center gap-2.5 cursor-pointer">
          <input type="checkbox" checked={outreachEnabled} onChange={(e) => setOutreachEnabled(e.target.checked)}
            className="w-4 h-4 rounded accent-[var(--primary)]" />
          <span className="text-[13px] font-medium text-fg">Outreach handoff enabled</span>
        </label>
        <p className="text-xs text-faint mt-1 ml-[26px]">
          Qualified prospects are sent to the external CRM for a human to review — this platform never sends outreach
          itself.
        </p>
      </div>

      {error && <Notice tone="error">{error}</Notice>}

      <div className="border-t border-border pt-4 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <span className="text-[13px] font-medium text-fg block">Prospect discovery</span>
            <span className="text-xs text-faint">Own opt-in — real SERP-backed, evidence-gated, cron-only. Never gated on other DataForSEO features being present.</span>
          </div>
          <div className="shrink-0">
            <OnOffToggle ariaLabel="Prospect discovery" on={prospectDiscoveryEnabled} disabled={discoveryToggling}
              offLabel="Disabled" onLabel="Enabled" onChange={toggleProspectDiscovery} />
          </div>
        </div>

        <div>
          <span className="text-xs font-medium text-fg block mb-1.5">CRM webhook token</span>
          {crmToken ? (
            <div className="rounded-control bg-muted px-3 py-2 font-mono text-xs text-fg break-all select-all">{crmToken}</div>
          ) : (
            <Button variant="light" onClick={issueCrmToken} disabled={issuingToken}>
              {issuingToken ? 'Generating…' : 'Generate CRM Token'}
            </Button>
          )}
          <span className="block text-xs text-faint mt-1.5">
            Give this to the external CRM: <code>GET /api/crm/export</code> to pull staff-approved prospects,
            <code> POST /api/crm/webhook</code> to report real outcome status back, both authenticated with
            <code> Authorization: Bearer &lt;token&gt;</code>.
          </span>
        </div>
      </div>

      <Button type="submit" variant="primary" disabled={saving}>
        {saving ? 'Saving…' : 'Save Product Growth Config'}
      </Button>
    </form>
  );
}

// ── Business Goals tab ───────────────────────────────────────────────────
// Stage 2 of the goal-driven-prioritization plan (Stage 1: server/routes/
// clients.js goals routes + server/agents/lib/goal-alignment.js). Every
// field here maps 1:1 to server/store/site-goals.js's shapeGoal output —
// no client-side transform beyond the comma-separated page-patterns list,
// same csvToList convention ProductGrowthTab already uses above.
const GOAL_TYPES = [
  'generate_leads', 'increase_organic_traffic', 'increase_conversions',
  'reduce_bounce_rate', 'increase_organic_visibility', 'increase_qualified_traffic',
  'grow_bookings', 'grow_sales',
  'book_demos', 'grow_signups', 'activate_users',
  'custom',
];

const EMPTY_GOAL_FORM = {
  goalType: GOAL_TYPES[0],
  objective: '',
  targetBusinessArea: '',
  targetPagePatterns: '',
  primaryMetric: '',
  description: '',
  importance: 1,
};

function goalToForm(g) {
  return {
    goalType: g.goalType,
    objective: g.objective || '',
    targetBusinessArea: g.targetBusinessArea || '',
    targetPagePatterns: (g.targetPagePatterns || []).join(', '),
    primaryMetric: g.primaryMetric || '',
    description: g.description || '',
    importance: g.importance ?? 1,
  };
}

function GoalForm({ clientId, initial, onCancel, onSubmit, submitLabel }) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // Stage 2b: custom-goal AI structure preview. This only ever fills the
  // fields below — it never calls onSubmit itself, so the existing Save
  // button below is still the one explicit confirm step before anything is
  // persisted, per the brief's "never auto-save an AI-structured goal" rule.
  const [customDescription, setCustomDescription] = useState('');
  const [proposing, setProposing] = useState(false);
  const [proposeError, setProposeError] = useState(null);
  const [proposed, setProposed] = useState(false);

  const suggestStructure = async () => {
    if (!customDescription.trim()) return setProposeError('Describe the goal first.');
    setProposing(true);
    setProposeError(null);
    try {
      const proposal = await api.clients.goals.structurePreview(clientId, customDescription.trim());
      setForm((f) => ({
        ...f,
        objective: proposal.objective,
        targetBusinessArea: proposal.targetBusinessArea || '',
        targetPagePatterns: (proposal.targetPagePatterns || []).join(', '),
        primaryMetric: proposal.primaryMetric || '',
      }));
      setProposed(true);
    } catch (err) {
      setProposeError(err.message || 'Could not suggest a structure.');
    } finally {
      setProposing(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.objective.trim()) return setError('objective is required.');
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        goalType: form.goalType,
        objective: form.objective.trim(),
        targetBusinessArea: form.targetBusinessArea.trim() || null,
        targetPagePatterns: csvToList(form.targetPagePatterns),
        primaryMetric: form.primaryMetric.trim() || null,
        description: form.description.trim() || null,
        importance: Number(form.importance) || 1,
      });
    } catch (err) {
      setError(err.message || 'Could not save.');
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-card bg-[#fcfcfb] p-4" style={ringStyle}>
      <Select label="Goal type" value={form.goalType} onChange={set('goalType')}>
        {GOAL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </Select>

      {form.goalType === 'custom' && (
        <div className="rounded-control bg-white p-3 space-y-2" style={ringStyle}>
          <Field as="textarea" label="Describe the goal in your own words" value={customDescription}
            onChange={(e) => setCustomDescription(e.target.value)}
            placeholder="e.g. We want more small teams finding us for our new team-scheduling feature" />
          {proposeError && <Notice tone="error">{proposeError}</Notice>}
          <Button variant="light" size="sm" onClick={suggestStructure} disabled={proposing}>
            {proposing ? 'Suggesting…' : 'Suggest structure with AI'}
          </Button>
          {proposed && (
            <p className="text-xs text-faint">
              AI-suggested below — review and edit before saving.
            </p>
          )}
        </div>
      )}

      <Field label="Objective" value={form.objective} onChange={set('objective')}
        placeholder="e.g. Grow qualified demo bookings from organic search 20% this quarter" />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Target business area" value={form.targetBusinessArea} onChange={set('targetBusinessArea')} placeholder="e.g. Pricing, Onboarding" />
        <Field label="Primary metric" value={form.primaryMetric} onChange={set('primaryMetric')} placeholder="e.g. booked_demo conversions" />
      </div>

      <Field label="Target page patterns" value={form.targetPagePatterns} onChange={set('targetPagePatterns')} placeholder="Comma-separated, e.g. /pricing, /blog/*" />

      <Field label="Description" value={form.description} onChange={set('description')} placeholder="Optional context for how findings should be judged against this goal" />

      <Field className="sm:max-w-[260px]" label="Importance" type="number" min="1" value={form.importance} onChange={set('importance')}
        hint="Lower number = higher priority on ties." />

      {error && <Notice tone="error">{error}</Notice>}

      <div className="flex items-center gap-2 pt-1">
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? 'Saving…' : submitLabel}
        </Button>
        <Button variant="light" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

// Progress for a PRODUCT site's goals — read from the CRM/prospect pipeline and
// trial signups (server/store/product-funnel.js). Shown only for a 'product'
// property; a website client has no product funnel, so nothing is rendered for
// it. Counts are real rows only; website-side GA4 events are NOT included yet.
const PROGRESS_WINDOWS = [7, 30, 90];

function ProductGoalProgress({ clientId }) {
  const [days, setDays] = useState(30);
  const [state, setState] = useState({ loading: true, funnel: null, error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, funnel: null, error: null });
    api.clients.goals.progress(clientId, days)
      .then((r) => { if (!cancelled) setState({ loading: false, funnel: r.funnel, error: null }); })
      .catch((e) => { if (!cancelled) setState({ loading: false, funnel: null, error: e.message || 'Could not load goal progress.' }); });
    return () => { cancelled = true; };
  }, [clientId, days]);

  const { loading, funnel, error } = state;
  const stats = funnel ? [
    { label: 'Demos booked', value: funnel.counts.demosBooked },
    { label: 'Trial signups', value: funnel.counts.trialSignups },
    { label: 'Converted', value: funnel.counts.converted },
  ] : [];

  return (
    <div className="rounded-card p-4 space-y-3" style={ringStyle}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-medium text-fg">Goal progress</span>
        <SegmentedTabs options={PROGRESS_WINDOWS.map((d) => ({ value: d, label: `${d}d` }))} value={days} onChange={setDays} />
      </div>

      {loading && <p className="text-[13px] text-faint">Loading…</p>}
      {error && <p className="text-[13px] text-[#b42318]">{error}</p>}

      {funnel && (
        <>
          {funnel.headline ? (
            <div>
              <p className="text-[24px] font-medium tracking-[-0.02em] text-fg leading-none tnum">{funnel.headline.value}</p>
              <p className="text-xs text-faint mt-1.5">
                {funnel.headline.label} · last {funnel.windowDays} days · conversion event: {funnel.conversionEvent}
              </p>
            </div>
          ) : (
            <p className="text-xs text-faint">
              {funnel.conversionEvent
                ? `"${funnel.conversionEvent}" doesn't match a tracked funnel stage, so no single headline is shown.`
                : 'Set a conversion event in the Product Growth tab to see a headline number.'}
            </p>
          )}
          <div className="grid grid-cols-3 gap-2">
            {stats.map((st) => (
              <div key={st.label} className="rounded-control bg-muted px-3 py-2">
                <p className="text-[15px] font-medium text-fg tnum">{st.value}</p>
                <p className="text-xs text-faint">{st.label}</p>
              </div>
            ))}
          </div>
          {funnel.counts.competitorSuspectSignups > 0 && (
            <p className="text-xs text-faint">
              {funnel.counts.competitorSuspectSignups} signup{funnel.counts.competitorSuspectSignups === 1 ? '' : 's'} flagged as likely competitors — not counted above.
            </p>
          )}
          <p className="text-xs text-faint-2">
            From the CRM pipeline and trial signups. Website-side events (visits, form views) are not included yet.
          </p>
        </>
      )}
    </div>
  );
}

function GoalsTab({ client }) {
  const [goals, setGoals] = useState(null); // null = loading
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState(null);

  const reload = () => api.clients.goals.list(client.id).then(setGoals).catch(() => setGoals([]));
  useEffect(() => { reload(); }, [client.id]);

  const toggleStatus = async (goal) => {
    const next = goal.status === 'active' ? 'paused' : 'active';
    setGoals((gs) => gs.map((g) => (g.id === goal.id ? { ...g, status: next } : g)));
    try {
      await api.clients.goals.setStatus(client.id, goal.id, next);
    } catch (err) {
      setError(err.message || 'Could not update status.');
      reload();
    }
  };

  if (goals === null) return <p className="text-[13px] text-faint py-4">Loading…</p>;

  return (
    <div className="space-y-4">
      <p className="text-xs leading-5 text-faint">
        Business goals let the decision engine weigh findings against what this client actually cares about right
        now, instead of treating every recommendation as equally important. A goal only affects prioritization — it
        never blocks or forces a decision on its own.
      </p>

      {client.propertyType === 'product' && <ProductGoalProgress clientId={client.id} />}

      {error && <Notice tone="error">{error}</Notice>}

      {goals.length === 0 && !adding && (
        <p className="text-[13px] text-faint py-2">No goals set yet.</p>
      )}

      <div className="space-y-2">
        {goals.map((g) => (
          <div key={g.id} className={editingId === g.id ? '' : 'rounded-card p-4'} style={editingId === g.id ? undefined : ringStyle}>
            {editingId === g.id ? (
              <GoalForm
                clientId={client.id}
                initial={goalToForm(g)}
                submitLabel="Save Goal"
                onCancel={() => setEditingId(null)}
                onSubmit={async (body) => {
                  const updated = await api.clients.goals.update(client.id, g.id, body);
                  setGoals((gs) => gs.map((x) => (x.id === g.id ? updated : x)));
                  setEditingId(null);
                }}
              />
            ) : (
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Badge tone="primary">{g.goalType}</Badge>
                    <Badge tone={g.status === 'active' ? 'green' : 'grey'}>{g.status}</Badge>
                    <span className="text-xs text-faint">priority {g.importance}</span>
                  </div>
                  <p className="text-[13px] font-medium text-fg mt-2">{g.objective}</p>
                  {g.description && <p className="text-xs text-text mt-1">{g.description}</p>}
                  {(g.targetPagePatterns?.length > 0 || g.primaryMetric) && (
                    <p className="text-xs text-faint mt-1">
                      {g.primaryMetric && <>metric: {g.primaryMetric}</>}
                      {g.primaryMetric && g.targetPagePatterns?.length > 0 && ' · '}
                      {g.targetPagePatterns?.length > 0 && <>pages: {g.targetPagePatterns.join(', ')}</>}
                    </p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <Button variant="light" size="sm" onClick={() => setEditingId(g.id)}>Edit</Button>
                  <Button variant="light" size="sm" onClick={() => toggleStatus(g)}>
                    {g.status === 'active' ? 'Pause' : 'Activate'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {adding ? (
        <GoalForm
          clientId={client.id}
          initial={EMPTY_GOAL_FORM}
          submitLabel="Add Goal"
          onCancel={() => setAdding(false)}
          onSubmit={async (body) => {
            const created = await api.clients.goals.create(client.id, body);
            setGoals((gs) => [...gs, created]);
            setAdding(false);
          }}
        />
      ) : (
        <Button variant="light" onClick={() => setAdding(true)}>
          <Plus size={14} />Add Goal
        </Button>
      )}
    </div>
  );
}

const TABS = [
  { value: 'general', label: 'General' },
  { value: 'integrations', label: 'Integrations' },
  { value: 'ai', label: 'AI Configuration' },
  { value: 'repository', label: 'Repository' },
  { value: 'advanced', label: 'Advanced' },
  { value: 'goals', label: 'Goals' },
];

// Only shown for a 'product' property (see PROPERTY_TYPES in
// ClientOnboarding.jsx) — a 'website' client never sees this tab, and
// nothing in it assumes any specific product.
const PRODUCT_GROWTH_TAB = { value: 'product-growth', label: 'Product Growth' };

export default function ClientDrawer({ client, owner, isOpen, onClose, onReload, initialTab = 'general' }) {
  const [tab, setTab] = useState(initialTab);

  // Reset to the requested tab whenever a different client's drawer opens.
  const [lastClientId, setLastClientId] = useState(client?.id);
  if (client && client.id !== lastClientId) {
    setLastClientId(client.id);
    if (tab !== initialTab) setTab(initialTab);
  }

  if (!client) return null;

  const tabs = client.propertyType === 'product' ? [...TABS, PRODUCT_GROWTH_TAB] : TABS;

  return (
    <Drawer isOpen={isOpen} onClose={onClose} title={client.name} subtitle={client.websiteDomain || 'no domain configured'} icon={Building} maxWidth="max-w-2xl">
      <Tabs tabs={tabs} active={tab} onChange={setTab} />
      {tab === 'general' && <GeneralTab client={client} owner={owner} />}
      {tab === 'integrations' && <IntegrationsTab client={client} onReload={onReload} />}
      {tab === 'ai' && <AiConfigTab client={client} onReload={onReload} />}
      {tab === 'repository' && <RepositoryTab client={client} onReload={onReload} />}
      {tab === 'advanced' && <AdvancedTab client={client} onReload={onReload} onClose={onClose} />}
      {tab === 'goals' && <GoalsTab client={client} />}
      {tab === 'product-growth' && <ProductGrowthTab client={client} />}
    </Drawer>
  );
}
