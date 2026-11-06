import { useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, ExternalLink } from 'lucide-react';
import { api } from '../../api.js';
import Button from '../Button.jsx';
import Field from '../Field.jsx';
import { usePosthogState } from '../../lib/posthog-state.jsx';

// Connect a client's own PostHog, the way Google is connected: a button, PostHog's own sign-in, then choose which of
// their PostHog projects is this website. OPTIONAL, and the screen says so first, because most clients do not use
// PostHog and a step that looks required makes them stop and ask.
//
// What this screen is careful about:
//   - It never shows a token or key back. The server does not return one, so a masked placeholder would be a lie
//     about what we hold.
//   - It verifies before it saves. A wrong project, region or key is told to them as soon as they press the button.
//   - Where "Connect with PostHog" is not available (the server has no public https address, as on a laptop, or no
//     encryption key) it says so and offers the older paste-a-key form instead of a dead button.
//   - It explains what they get, and how to install PostHog if they do not have it yet.

const ERRORS = {
  cancelled: 'You closed the PostHog screen before finishing, so nothing was connected.',
  expired: 'That PostHog sign-in took too long or did not start here. Please try again.',
  denied: 'Your account cannot connect PostHog for this project.',
  exchange_failed: 'PostHog did not accept the sign-in. Please try again.',
  missing_scopes: 'PostHog access has to be allowed in full on the PostHog screen. Please try again and approve it.',
  no_refresh_token: 'PostHog did not return a long-lived sign-in. Please try again and approve the screen in full.',
  unreachable: 'We could not reach PostHog just now. Please try again in a minute.',
};
// Which choice an existing connection's address corresponds to, so "Reconnect" goes back to the SAME PostHog and not the
// US default (an EU or self-hosted client sent to the US sign-in would save a grant against the wrong host).
const regionOf = (host) => (!host || /us\.posthog\.com/i.test(host) ? { region: 'us', selfHost: '' } : /eu\.posthog\.com/i.test(host) ? { region: 'eu', selfHost: '' } : { region: 'self', selfHost: host });
const REGIONS = [{ id: 'us', label: 'US cloud' }, { id: 'eu', label: 'EU cloud' }, { id: 'self', label: 'Self-hosted' }];

export default function PosthogFields({ siteId, notice = null, initialGuide = false }) {
  const { refresh } = usePosthogState();
  const [state, setState] = useState(null); // GET /connect/posthog: { connected, pending, connection, canConnect, guide }
  const [region, setRegion] = useState('us');
  const [selfHost, setSelfHost] = useState('');
  const [projects, setProjects] = useState(null); // while pending: the PostHog projects this account can read
  const [pick, setPick] = useState(null);
  const [guideOpen, setGuideOpen] = useState(initialGuide);
  const [keyOpen, setKeyOpen] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [host, setHost] = useState('https://us.posthog.com');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const adopt = (r) => { setState(r); if (r?.connection?.host) { const g = regionOf(r.connection.host); setRegion(g.region); setSelfHost(g.selfHost); } };
  const reload = () => api.project.connect.posthog(siteId).then(adopt).catch(() => setState({ connected: false, canConnect: false }));
  useEffect(() => { let alive = true; api.project.connect.posthog(siteId).then((r) => { if (alive) adopt(r); }).catch(() => { if (alive) setState({ connected: false, canConnect: false }); }); return () => { alive = false; }; }, [siteId]);

  // Signed in to PostHog but no project chosen yet: load the list (one project is picked for them by the server).
  useEffect(() => {
    if (!state?.pending) return undefined;
    let alive = true;
    api.project.connect.posthogProjects(siteId)
      .then((r) => { if (!alive) return; setProjects(r.projects || []); setPick((r.projects || [])[0]?.id ?? null); })
      .catch((e) => { if (alive) { setProjects([]); setError(e?.message || 'We could not list your PostHog projects.'); } });
    return () => { alive = false; };
  }, [state?.pending, siteId]);

  const start = async () => {
    setBusy(true); setError(null);
    try {
      const { url } = await api.project.connect.posthogStart(siteId, region, region === 'self' ? selfHost.trim() : undefined);
      window.location.assign(url);
    } catch (e) { setError(e?.message || 'PostHog could not be opened.'); setBusy(false); }
  };
  const choose = async () => {
    setBusy(true); setError(null);
    try {
      await api.project.connect.posthogSelect(siteId, String(pick));
      await reload(); await refresh();
    } catch (e) { setError(e?.message || 'That PostHog project could not be connected.'); } finally { setBusy(false); }
  };
  const saveKey = async () => {
    setBusy(true); setError(null);
    try {
      await api.project.connect.posthogSave(siteId, { projectId: projectId.trim(), host: host.trim(), apiKey: apiKey.trim() });
      setApiKey(''); await reload(); await refresh();
    } catch (e) { setError(e?.message || 'PostHog could not be connected.'); } finally { setBusy(false); }
  };
  const disconnect = async () => {
    setBusy(true); setError(null);
    try { await api.project.connect.posthogDisconnect(siteId); setProjects(null); await reload(); await refresh(); }
    catch (e) { setError(e?.message || 'PostHog could not be disconnected.'); } finally { setBusy(false); }
  };

  if (!state) return <div className="text-sm text-faint">Checking…</div>;

  const banner = notice?.pherror ? <Banner tone="red">{ERRORS[notice.pherror] || 'PostHog could not be connected.'}</Banner>
    : notice?.posthog === 'saved' ? <Banner tone="green">We found your PostHog project and connected it automatically.</Banner>
    : notice?.posthog === 'connected' && state.pending ? <Banner tone="green">Signed in to PostHog. Choose which project is this website.</Banner> : null;
  const errorBox = error && <Banner tone="red">{error}</Banner>;

  // ── Connected ──
  if (state.connected && state.connection) {
    const c = state.connection;
    const bad = c.status === 'error';
    return (
      <div className="space-y-3">
        {banner}
        <div className={`rounded-card border px-4 py-3 text-sm ${bad ? 'bg-[#fdecec] border-[#f3c6c6] text-[#b42318]' : 'bg-[#edf7ee] border-[#c6e7c9] text-[#1b5e20]'}`}>
          <div className="font-medium">{bad ? 'PostHog is connected but not working' : 'PostHog connected'}</div>
          <p className="mt-1">
            {c.project_name || `Project ${c.project_id}`} on {hostLabel(c.host)}{c.connected_as ? `, as ${c.connected_as}` : ''}.
            {c.status === 'pending' && ' We are checking it now. The first numbers arrive tonight.'}
          </p>
          {bad && c.status_error && <p className="mt-1">{c.status_error}</p>}
          {bad && <p className="mt-1">Reconnect to fix it.</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {bad && state.canConnect && <Button variant="primary" onClick={start} disabled={busy}>{busy ? 'Opening PostHog…' : 'Reconnect with PostHog'}</Button>}
          <Button variant="light" onClick={disconnect} disabled={busy}>{busy ? 'Removing…' : 'Disconnect PostHog'}</Button>
        </div>
        {errorBox}
      </div>
    );
  }

  // ── Signed in, choosing the project ──
  if (state.pending) {
    return (
      <div className="space-y-3">
        {banner}
        <p className="text-[13px] leading-relaxed">Which PostHog project is this website?</p>
        {projects === null ? <div className="text-sm text-faint">Loading your PostHog projects…</div>
          : projects.length === 0 ? <Banner tone="red">That account has no PostHog project we can read. Sign in with another account.</Banner>
          : (
            <div role="radiogroup" className="space-y-2">
              {projects.map((p) => {
                const on = String(pick) === String(p.id);
                return (
                  <button key={p.id} type="button" role="radio" aria-checked={on} onClick={() => setPick(p.id)}
                    className={`w-full flex items-center gap-3 text-left rounded-card px-3.5 py-3 ${on ? 'bg-primary-tint' : 'bg-white'}`}
                    style={{ boxShadow: on ? 'inset 0 0 0 1px var(--primary-ring)' : '0 0 0 1px var(--border-2)' }}>
                    <span className="w-4 h-4 rounded-full shrink-0" style={{ boxShadow: `inset 0 0 0 ${on ? 5 : 1.5}px ${on ? 'var(--primary)' : '#c9c7c3'}` }} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13.5px] font-medium text-fg truncate">{p.name}</span>
                      {p.url && <span className="block text-xs text-faint truncate">{p.url}</span>}
                    </span>
                    <span className="text-xs text-faint font-mono">#{p.id}</span>
                  </button>
                );
              })}
            </div>
          )}
        {errorBox}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={choose} disabled={busy || pick == null || !projects?.length}>{busy ? 'Checking with PostHog…' : 'Use this project'}</Button>
          <Button variant="light" onClick={disconnect} disabled={busy}>Use a different account</Button>
        </div>
      </div>
    );
  }

  // ── Not connected ──
  const keyReady = projectId.trim() && apiKey.trim();
  return (
    <div className="space-y-4">
      {banner}
      <p className="text-[13px] leading-relaxed">
        See where people give up: the signup form, the pricing page, the checkout.
        <span className="text-faint"> Skip it if you don&rsquo;t use PostHog.</span>
      </p>

      {state.canConnect ? (
        <div className="rounded-card px-4 py-3.5" style={{ boxShadow: '0 0 0 1px var(--border-2)' }}>
          <div className="text-[13px] font-medium text-fg">Sign in with the PostHog account that owns your site&rsquo;s data</div>
          <p className="mt-1 text-xs text-faint leading-[18px]">PostHog opens in a new screen. You allow SuperRank to read your events (read-only), then you come straight back. No keys to copy.</p>
          <div className="mt-3 text-xs text-faint">Where is your PostHog?</div>
          <div className="mt-1.5 inline-flex rounded-control" style={{ boxShadow: '0 0 0 1px var(--input)' }} role="radiogroup">
            {REGIONS.map((r, i) => (
              <button key={r.id} type="button" role="radio" aria-checked={region === r.id} onClick={() => setRegion(r.id)}
                className={`h-8 px-3.5 text-[13px] font-medium ${i ? 'border-l border-border-2' : ''} ${region === r.id ? 'bg-primary-tint text-[#7a3400]' : 'text-text'} ${i === 0 ? 'rounded-l-control' : ''} ${i === REGIONS.length - 1 ? 'rounded-r-control' : ''}`}>
                {r.label}
              </button>
            ))}
          </div>
          {region === 'self' && (
            <div className="mt-3"><Field label="Your PostHog address" value={selfHost} onChange={(e) => setSelfHost(e.target.value)} placeholder="https://posthog.yourcompany.com" autoComplete="off" hint="Your own domain, starting with https://." /></div>
          )}
          <div className="mt-3.5 flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={start} disabled={busy || (region === 'self' && !selfHost.trim())}>
              <ExternalLink size={14} />{busy ? 'Opening PostHog…' : 'Connect with PostHog'}
            </Button>
            <span className="text-xs text-faint">Read access only. You can disconnect any time.</span>
          </div>
        </div>
      ) : (
        <p className="text-xs leading-[18px]" style={{ color: '#8a5300' }}>
          &ldquo;Connect with PostHog&rdquo; is not available on this server yet. You can connect with a PostHog API key below.
        </p>
      )}

      <Disclosure open={guideOpen} onToggle={() => setGuideOpen((v) => !v)} title="Don’t have PostHog on your site yet?">
        <p>PostHog has to be on your website before we can read from it. This takes about five minutes.</p>
        <ol className="mt-3 space-y-3">
          <Step n={1} title="Create a free PostHog account"><>Go to <a className="text-primary font-medium hover:underline" href="https://posthog.com" target="_blank" rel="noreferrer">posthog.com</a>, choose US or EU cloud, and create a project for this website.</></Step>
          <Step n={2} title="Add PostHog's code to your site's <head>">In PostHog, open Settings, then your project, and copy the web snippet it shows (it already contains your own project key). Your web developer can add it in a minute.</Step>
          <Step n={3} title="Visit your site once, then come back">Events usually show up in PostHog within a minute. Then connect PostHog here and we start reading it tonight.</Step>
        </ol>
      </Disclosure>

      <Disclosure open={keyOpen || !state.canConnect} onToggle={() => setKeyOpen((v) => !v)} title="Use an API key instead" hideToggle={!state.canConnect}>
        <div className="space-y-4">
          <Field label="PostHog project ID" value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="e.g. 4521" inputMode="numeric" autoComplete="off" hint="In PostHog: Settings → Project. It’s a number." />
          <Field label="Personal API key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="phx_…" autoComplete="off" hint="Avatar menu → Personal API keys. Read access only. Encrypted, and never shown again." />
          <Field label="PostHog address" value={host} onChange={(e) => setHost(e.target.value)} placeholder="https://us.posthog.com" autoComplete="off" hint="Leave as-is for the US cloud. Use eu.posthog.com for the EU, or your own domain if self-hosted." />
          <Button variant="primary" onClick={saveKey} disabled={busy || !keyReady}>{busy ? 'Checking with PostHog…' : 'Connect with this key'}</Button>
        </div>
      </Disclosure>

      {errorBox}
    </div>
  );
}

function Banner({ tone, children }) {
  const c = tone === 'red' ? 'bg-[#fdecec] border-[#f3c6c6] text-[#b42318]' : 'bg-[#edf7ee] border-[#c6e7c9] text-[#1b5e20]';
  return <div className={`rounded-card border px-4 py-3 text-sm flex gap-2 ${c}`}>{tone === 'green' && <CheckCircle2 size={16} className="mt-0.5 shrink-0" />}<span>{children}</span></div>;
}
function Disclosure({ open, onToggle, title, children, hideToggle = false }) {
  return (
    <div className="rounded-card" style={{ boxShadow: '0 0 0 1px var(--border-2)' }}>
      {!hideToggle && (
        <button type="button" onClick={onToggle} aria-expanded={open} className="w-full flex items-center gap-2 px-4 py-3 text-left text-[13.5px] font-medium text-fg">
          <span>{title}</span>
          <ChevronDown size={14} className={`ml-auto text-faint transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      )}
      {open && <div className={`px-4 pb-4 text-[13px] leading-[19px] text-text ${hideToggle ? 'pt-4' : ''}`}>{children}</div>}
    </div>
  );
}
function Step({ n, title, children }) {
  return (
    <li className="grid grid-cols-[28px_minmax(0,1fr)] gap-3 items-start">
      <span className="w-7 h-7 rounded-full grid place-items-center text-[13px] font-semibold bg-primary-tint text-primary-strong" style={{ boxShadow: 'inset 0 0 0 1px var(--primary-ring)' }}>{n}</span>
      <span><b className="block text-[14px] font-semibold text-fg">{title}</b><span className="block mt-0.5">{children}</span></span>
    </li>
  );
}
function hostLabel(host) {
  if (!host) return 'PostHog';
  if (/us\.posthog\.com/i.test(host)) return 'PostHog US cloud';
  if (/eu\.posthog\.com/i.test(host)) return 'PostHog EU cloud';
  return host.replace(/^https?:\/\//, '');
}
