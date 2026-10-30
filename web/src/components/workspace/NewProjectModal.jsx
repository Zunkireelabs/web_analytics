import { useEffect, useState } from 'react';
import { Download, Check, FolderPlus, GitBranch, Globe, Loader2, Search, BarChart3, Target, AlertTriangle, ExternalLink, Info, Link2, MapPin } from 'lucide-react';
import { api } from '../../api.js';
import Modal from '../Modal.jsx';
import Field from '../Field.jsx';
import Button from '../Button.jsx';
import Badge from '../Badge.jsx';
import GoalFields from './GoalFields.jsx';
import BusinessProfileFields, { gbpReady, gbpSource } from './BusinessProfileFields.jsx';
import { DEFAULT_GOAL, goalComplete } from '../../lib/workspace.js';

// Adding a project, end to end, with no staff step anywhere in it:
//
//   1 Details   name + website address  (the project is created here, so the
//                                        steps below have something to attach to)
//   2 Goal      the presets or your own words
//   3 Google    PICK a Search Console property and a GA4 property from the
//               lists our Google account can actually see
//   4 Business  Google Business Profile, optional: paste its Maps link, learn how to
//     Profile   create one (and why it matters), or say it does not apply. Nothing is
//               read from Google, so it needs no extra access, and it never blocks.
//   5 GitHub    PICK the repository from the list our GitHub app can reach.
//               Required: the agent reads the site's code to make a fix, so a
//               project without a repo has nothing it can open a PR against.
//   6 Baseline  runs by itself and lands on the project
//
// Nothing is typed in that could be mistyped — the two connect steps are
// pickers over real listings, so a property or repo that is missing is honest
// evidence the access isn't there yet, visible BEFORE the baseline runs rather
// than as a failure after it.
//
// Closing part-way is safe: the project already exists, and the Projects page
// shows "Finish setting up" on it, which reopens this at the step still owed.
const STEPS = ['Details', 'Goal', 'Google', 'Business', 'GitHub', 'Baseline'];

const CARD = { boxShadow: '0 0 0 1px var(--input), 0 1px 2px rgba(0,0,0,.03)' };
const CARD_ON = { boxShadow: '0 0 0 1px var(--primary), 0 0 0 4px var(--primary-tint)' };

// A name to suggest from the address they typed: acme.com becomes Acme, www.blog.acme.com becomes Acme.
// Only a starting point, they can change it.
function nameFromDomain(raw) {
  const host = String(raw || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0];
  const parts = host.split('.').filter(Boolean);
  if (!parts.length || (parts.length === 1 && host.length < 2)) return '';
  const label = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : '';
}

function Stepper({ step }) {
  return (
    <div className="mb-6" role="list" aria-label={`Step ${step} of ${STEPS.length}`}>
      <div className="flex items-center">
        {STEPS.map((label, i) => {
          const n = i + 1, on = n === step, done = n < step;
          return (
            <div key={label} role="listitem" aria-current={on ? 'step' : undefined} className={`flex items-center min-w-0 ${i > 0 ? 'flex-1' : ''}`}>
              {/* The line leading into a step fills in once the step before it is done. */}
              {i > 0 && <span className="h-0.5 flex-1 mx-2 rounded-full" style={{ background: done || on ? 'var(--primary)' : 'var(--border-2)', opacity: done ? 1 : on ? 0.35 : 1 }} />}
              <span className={`w-7 h-7 rounded-full grid place-items-center text-xs font-semibold shrink-0 transition-colors ${done ? 'bg-primary text-white' : on ? 'bg-fg text-white ring-4 ring-[var(--muted)]' : 'bg-muted text-faint'}`}>
                {done ? <Check size={13} strokeWidth={3} /> : n}
              </span>
            </div>
          );
        })}
      </div>
      {/* Names sit under their circles; on a phone only the current one is named. */}
      <div className="flex mt-2">
        {STEPS.map((label, i) => {
          const n = i + 1, on = n === step, done = n < step;
          return (
            <span key={label} className={`flex-1 text-xs ${i === 0 ? 'text-left' : i === STEPS.length - 1 ? 'text-right' : 'text-center'} ${on ? 'font-medium text-fg' : done ? 'hidden sm:block text-text' : 'hidden sm:block text-faint'}`}>{label}</span>
          );
        })}
      </div>
    </div>
  );
}

// One row in a picker: the thing's name, a detail line, and a tick when chosen.
function PickRow({ on, title, detail, badge, onClick }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-card bg-white text-left" style={on ? CARD_ON : CARD}>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-fg truncate">{title}</span>
        {detail && <span className="block text-xs text-faint truncate">{detail}</span>}
      </span>
      {badge && <Badge tone="grey">{badge}</Badge>}
      {on && <Check size={15} className="text-primary shrink-0" />}
    </button>
  );
}

// The site's own favicon when the name is a real address; a plain icon when it is not, or when the image cannot load.
function SiteIcon({ host, Fallback = Globe }) {
  const [failed, setFailed] = useState(false);
  const real = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host || '');
  if (!real || failed) return <span className="w-5 h-5 rounded grid place-items-center bg-muted text-faint shrink-0"><Fallback size={12} /></span>;
  return <img src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`} alt="" width={20} height={20} onError={() => setFailed(true)} className="w-5 h-5 rounded shrink-0" />;
}

// A long list of Google properties to choose one from: radio rows, the site that matches the
// project's address floated to the top and marked, and a filter once the list is long.
const hostOf = (v) => String(v || '').toLowerCase().replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
function PropertyList({ items, value, onPick, siteHost, noun = 'properties', grid = false }) {
  const [q, setQ] = useState('');
  const host = hostOf(siteHost);
  const rows = items
    .map((r) => ({ ...r, best: r.best ?? (Boolean(host) && hostOf(r.domain || r.title) === host) }))
    .filter((r) => !q.trim() || `${r.title} ${r.detail}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => Number(b.best) - Number(a.best));
  return (
    <div>
      {items.length > 5 && (
        <div className="relative mb-2">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"><Search size={13} /></span>
          <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${items.length} ${noun}`} style={{ paddingLeft: 30, height: 32, fontSize: 13 }} />
        </div>
      )}
      {grid ? (
        <div className="max-h-[232px] overflow-y-auto -m-1 p-1">
          {rows.length === 0 && <div className="px-3 py-3 text-xs text-faint">Nothing matches “{q}”.</div>}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {rows.map((r) => {
              const on = value === r.id;
              const twin = rows.some((o) => o !== r && o.title === r.title);
              return (
                <button key={r.id} type="button" onClick={() => onPick(r.id)} aria-pressed={on} title={r.hint || r.title}
                  className="min-w-0 flex items-center gap-2 px-2.5 py-2 min-h-[40px] rounded-card bg-white text-left transition-colors hover:bg-muted" style={on ? CARD_ON : CARD}>
                  <SiteIcon host={r.domain || r.title} Fallback={r.icon} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-fg truncate leading-4">{r.title}</span>
                    {twin && r.detail && <span className="block text-[11px] text-faint truncate leading-4">{r.detail}</span>}
                  </span>
                  {on && <Check size={14} strokeWidth={3} className="text-primary shrink-0" />}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
      <div className="rounded-card bg-white overflow-hidden" style={CARD}>
        <div className="max-h-[188px] overflow-y-auto divide-y" style={{ '--tw-divide-opacity': 1 }}>
          {rows.length === 0 && <div className="px-3 py-3 text-xs text-faint">Nothing matches “{q}”.</div>}
          {rows.map((r) => {
            const on = value === r.id;
            return (
              <button key={r.id} type="button" onClick={() => onPick(r.id)} aria-pressed={on}
                className={`w-full flex items-center gap-3 px-3 py-2 text-left ${on ? 'bg-primary-tint' : 'hover:bg-muted'}`} style={{ borderColor: 'var(--border)' }}>
                <span className="w-4 h-4 rounded-full shrink-0 grid place-items-center" style={{ boxShadow: `inset 0 0 0 ${on ? 5 : 1.5}px ${on ? 'var(--primary)' : 'var(--border-2)'}`, background: on ? '#fff' : 'transparent' }} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-fg truncate">{r.title}</span>
                  {r.detail && <span className="block text-xs text-faint truncate">{r.detail}</span>}
                </span>
                {r.best && <Badge tone="green">{r.bestLabel || 'Matches your site'}</Badge>}
                {!r.best && r.badge && <Badge tone="grey">{r.badge}</Badge>}
              </button>
            );
          })}
        </div>
      </div>
      )}
    </div>
  );
}

function Note({ tone = 'muted', icon: Icon, children }) {
  const tones = {
    muted: { background: 'var(--muted)', color: 'var(--text)' },
    amber: { background: '#fdf3e1', color: '#8a5300' },
    red: { background: '#fdecec', color: '#b42318' },
    green: { background: 'var(--green-tint)', color: 'var(--green)' },
  };
  return (
    <div className="flex items-start gap-2.5 rounded-control px-3 py-2.5 text-[13px] leading-5" style={tones[tone]}>
      {Icon && <Icon size={15} className="shrink-0 mt-0.5" />}
      <span className="min-w-0">{children}</span>
    </div>
  );
}

// `startStep` / `notice` are for coming BACK from Google's own screen, which leaves the app and returns
// to the Workspace page: the popup reopens on the Google step, with what happened
// ({ google: 'saved' | 'connected', error }) shown at the top of it.
export default function NewProjectModal({ workspace, first = false, project: existing = null, isOpen, onClose, onChanged, onOpenProject, startStep = null, notice = null }) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [nameTouched, setNameTouched] = useState(false); // once they type a name themselves, the address stops suggesting one
  const [goal, setGoal] = useState(DEFAULT_GOAL);
  const [project, setProject] = useState(existing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // The connect lists and what has been chosen so far.
  const [connect, setConnect] = useState(null); // null = loading
  const [github, setGithub] = useState(null); // the repositories, loaded when the GitHub step is reached; null = loading
  const [gsc, setGsc] = useState(null);
  const [ga4, setGa4] = useState(null);
  const [repo, setRepo] = useState(null);
  const [useStage, setUseStage] = useState(false); // review on a stage branch before production
  const [stage, setStage] = useState('stage');
  const [githubChecks, setGithubChecks] = useState(null);
  const [gbpChoice, setGbpChoice] = useState(null); // linked | none | not_applicable | null = not answered
  const [gbpUrl, setGbpUrl] = useState('');
  const [baseline, setBaseline] = useState(existing ? 'idle' : 'idle'); // idle | running | done | failed

  // Reopening on an existing project: start at the first step it still owes.
  useEffect(() => {
    if (!isOpen || !existing) return;
    setProject(existing);
    setName(existing.name || '');
    setDomain(existing.domain || '');
    if (existing.goal) setGoal(existing.goal);
    setStep(startStep || (!existing.goal ? 2 : 3));
    // Coming back from Google/GitHub the project arrives without its goal. Look it up before asking
    // again, or "Save goal" on step 2 would overwrite the goal the person already chose.
    if (existing.goal === undefined) {
      let cancelled = false;
      api.project.overview(existing.id)
        .then((r) => {
          const saved = r?.projects?.[0]?.goal;
          if (cancelled || !saved) return;
          setGoal(saved);
          setStep((cur) => (startStep ? cur : cur === 2 ? 3 : cur));
        })
        .catch(() => {});
      return () => { cancelled = true; };
    }
    return undefined;
  }, [isOpen, existing?.id]);

  // The two listings are fetched once the project exists, so steps 3 and 4 are
  // already populated when they are reached.
  const [branches, setBranches] = useState(null); // { names, defaultBranch, error } for the repository picked; null = not loaded
  const [branch, setBranch] = useState('');         // the production branch: work is cut from it
  const [mine, setMine] = useState(null); // the signed-in person's own GitHub repositories; null = not loaded
 // staff: 'app' = every repo the SuperRank app reaches, 'mine' = the signed-in GitHub account's own
  const [useShared, setUseShared] = useState(false); // staff only: list SuperRank's shared account instead of a connected one
  const loadConnect = async (siteId, { shared = false } = {}) => {
    setConnect(null);
    try {
      const data = await api.project.connect.state(siteId, { shared });
      setConnect(data);
      // What is already saved wins; otherwise the property matching the website address is pre-selected.
      setGsc((v) => v ?? data.state.google.gscProperty ?? data.google.suggested?.gscProperty ?? null);
      setGa4((v) => v ?? data.state.google.ga4PropertyId ?? data.google.suggested?.ga4PropertyId ?? null);
      setRepo((v) => v ?? data.state.github.repo ?? null);
      // What was already answered wins, so reopening the popup shows it instead of asking again.
      setGbpChoice((v) => v ?? data.state.businessProfile?.status ?? null);
      setGbpUrl((v) => v || data.state.businessProfile?.url || '');
    } catch (err) {
      setConnect({ error: err.message || 'Could not read what there is to connect.' });
    }
  };
  useEffect(() => { if (isOpen && project?.id && step >= 3 && !connect) loadConnect(project.id); }, [isOpen, project?.id, step]);
  // GitHub's list is slow (one call per installation): it starts loading while the person is still on the
  // Google step, so it is usually ready by the time they get to GitHub. Clients never get it (staff only).
  useEffect(() => {
    if (!isOpen || !project?.id || step < 3 || connect === null || connect.githubRestricted || github) return;
    api.project.connect.githubRepos(project.id).then(setGithub).catch((err) => setGithub({ error: err.message || 'GitHub could not be read right now.', repos: [], installations: [] }));
  }, [isOpen, project?.id, step, connect]);

  // Their own GitHub repositories, once they have signed in to GitHub (clients always use this; staff on its tab).
  useEffect(() => {
    if (!isOpen || !project?.id || step !== 5 || connect === null || !connect.github?.connected || mine) return;
    api.project.connect.githubMine(project.id).then(setMine).catch((err) => setMine({ signedIn: false, repos: [], error: err.message }));
  }, [isOpen, project?.id, step, connect]);

  // Once a repository is picked, read its branches so the person chooses instead of typing.
  useEffect(() => {
    if (!project?.id || !repo || effSource !== 'mine' || !connect?.github?.connected) { setBranches(null); return; }
    const [owner, name] = String(repo).split('/');
    let live = true;
    setBranches(null);
    api.project.connect.githubBranches(project.id, owner, name)
      .then((r) => { if (!live) return; setBranches({ names: r.branches.map((b) => b.name), defaultBranch: r.defaultBranch, error: r.error || null }); setBranch(r.defaultBranch || ''); })
      .catch((err) => { if (live) setBranches({ names: [], defaultBranch: null, error: err.message }); });
    return () => { live = false; };
  }, [repo, project?.id, connect?.github?.connected]);

  const close = () => {
    const created = project;
    setStep(1); setName(''); setDomain(''); setNameTouched(false); setGoal(DEFAULT_GOAL); setProject(null);
    setConnect(null); setGithub(null); setGsc(null); setGa4(null); setRepo(null); setGithubChecks(null); setUseStage(false); setStage('stage'); setUseShared(false);
    setBaseline('idle'); setError(null); setBusy(false); setMine(null); setBranches(null); setBranch('');
    onClose(created);
  };

  const run = async (fn) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (err) { setError(err.message || 'That did not work. Try again.'); } finally { setBusy(false); }
  };

  const createProject = () => run(async () => {
    // Coming back to this step after the project exists: nothing to create again.
    if (project?.id) { setStep(2); return; }
    const created = await api.workspace.createProject(workspace.id, { name: name.trim(), websiteDomain: domain.trim() || undefined });
    setProject(created);
    await onChanged?.();
    setStep(2);
  });

  const saveGoal = () => run(async () => {
    await api.project.setGoal(project.id, goal);
    await onChanged?.();
    setStep(3);
  });

  // "Connect with Google": ask the server for Google's address and go there. The person comes
  // back to the Workspace page, which reopens this popup on this step.
  const startGoogle = () => run(async () => {
    const { url } = await api.project.connect.googleStart(project.id);
    window.location.assign(url);
  });
  // "Connect with GitHub": GitHub's own screen, where the person chooses which repositories SuperRank may see.
  const startGithub = () => run(async () => {
    const { url } = await api.project.connect.githubStart(project.id);
    window.location.assign(url);
  });
  const disconnectGoogle = () => run(async () => {
    await api.project.connect.googleDisconnect(project.id);
    setGsc(null); setGa4(null);
    await loadConnect(project.id);
  });
  const showShared = () => { setUseShared(true); setGsc(null); setGa4(null); loadConnect(project.id, { shared: true }); };

  const saveGoogle = () => run(async () => {
    const r = await api.project.connect.google(project.id, { gscProperty: gsc, ga4PropertyId: ga4 });
    setConnect((c) => ({ ...c, state: r.state }));
    setStep(4);
  });

  useEffect(() => { if (isOpen && notice?.gbp) setGbpChoice('linked'); }, [isOpen, notice?.gbp]);

  const saveBusinessProfile = () => run(async () => {
    const r = await api.project.connect.businessProfile(project.id, { status: gbpChoice, ...(gbpChoice === 'linked' ? { url: gbpUrl } : {}) });
    setConnect((c) => ({ ...c, state: r.state }));
    setStep(5);
  });

  const restrictedNow = Boolean(connect?.githubRestricted);
  // Everyone connects the same way: signing in to GitHub as themselves. Only while that sign-in is not set up on the
  // server do staff fall back to the shared SuperRank app list, so a project can still be linked.
  const effSource = connect?.github?.canConnect || notice?.github ? 'mine' : 'app';
  const saveGithub = () => run(async () => {
    const [owner, repoName] = String(repo).split('/');
    const usingMine = restrictedNow || effSource === 'mine';
    const r = await api.project.connect.github(project.id, { repoOwner: owner, repoName, ...(usingMine ? { source: 'mine' } : {}), ...(usingMine && branch ? { repoDefaultBranch: branch } : {}), ...(useStage && stage.trim() ? { prTargetBranch: stage.trim() } : {}) });
    setConnect((c) => ({ ...c, state: r.state }));
    setGithubChecks({ ...r.checks, techStack: r.techStack });
    setStep(6);
  });

  // A run that is already going (this popup was closed and reopened, the page was refreshed, a
  // second tab) is followed, never started again: the server holds a lock per project.
  const followRunningBaseline = async () => {
    const deadline = Date.now() + 20 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4000));
      const st = await api.project.baselineStatus(project.id);
      if (st.status !== 'running') return st.status;
    }
    return 'running';
  };
  const runBaseline = async () => {
    setBaseline('running'); setError(null);
    try {
      let outcome = (await api.project.baselineStatus(project.id)).status;
      if (outcome === 'idle') {
        const r = await api.project.baseline(project.id);
        outcome = r?.running ? 'running' : 'done';
      }
      if (outcome === 'running') outcome = await followRunningBaseline();
      if (outcome !== 'done') throw new Error(outcome === 'running' ? 'The baseline is still running. It keeps going on its own; check back in a few minutes.' : 'The baseline did not finish. SuperRank can run it again.');
      setBaseline('done');
      await onChanged?.();
    } catch (err) {
      setBaseline('failed');
      setError(err.message || 'The baseline could not finish. You can run it again from the project.');
    }
  };
  // The baseline starts by itself — the point of the flow is that nobody has to
  // be asked to kick it off.
  // ...but only when it can mean something: it is built from Google's real data, so
  // with Google not connected yet it waits rather than starting and failing.
  useEffect(() => {
    if (!isOpen || step !== 6 || baseline !== 'idle' || !project?.id || connect === null) return;
    if (connect?.state?.google?.connected) runBaseline();
    else setBaseline('waiting');
  }, [isOpen, step, baseline, project?.id, connect]);

  const errorBox = error && <Note tone="red" icon={AlertTriangle}>{error}</Note>;
  const listError = (list) => (list && !Array.isArray(list) ? list.error : null);

  // ───────── step bodies ─────────

  let body = null, footer = null, title = 'Add project', subtitle = null, icon = FolderPlus;

  if (step === 1) {
    if (first) { title = 'Add your first project'; subtitle = <>A project is one website you want to grow, in <span className="text-fg font-medium">{workspace?.name}</span></>; }
    else subtitle = <>To <span className="text-fg font-medium">{workspace?.name}</span></>;
    const shownName = name.trim();
    body = (
      <form id="new-project-form" onSubmit={(e) => { e.preventDefault(); createProject(); }} className="space-y-4">
        <label className="fld">
          <span className="fld__label">Website address</span>
          <div className="relative">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"><Globe size={14} /></span>
            <input type="text" value={domain} autoFocus onChange={(e) => { setDomain(e.target.value); if (!nameTouched) setName(nameFromDomain(e.target.value)); }} placeholder="blog.acme.com" style={{ paddingLeft: 32 }} disabled={!!project?.id} />
          </div>
          <span className="fld__hint">Just the address, like acme.com. We use it to find the right Google property for you.</span>
        </label>
        <Field label="Project name" value={name} onChange={(e) => { setName(e.target.value); setNameTouched(true); }} placeholder="Acme Blog" required disabled={!!project?.id}
          hint={nameTouched || !name ? undefined : 'Filled in from your address. Change it if you like.'} />
        {shownName && (
          <div className="flex items-center gap-2.5 rounded-control bg-primary-tint px-3 py-2.5 text-xs text-text" style={{ boxShadow: 'inset 0 0 0 1px var(--primary-ring)' }}>
            <span className="w-7 h-7 rounded-control bg-white text-primary grid place-items-center font-semibold shrink-0" style={{ boxShadow: '0 0 0 1px var(--primary-ring)' }}>{shownName.charAt(0).toUpperCase()}</span>
            <div className="min-w-0"><div className="text-[13px] font-medium text-fg truncate">{shownName}</div><div className="truncate">{domain.trim() ? `${domain.trim()} · ` : ''}will be added to {workspace?.name}</div></div>
          </div>
        )}
        {first && (
          <div className="flex gap-2.5 rounded-control bg-muted px-3 py-2.5 text-xs leading-[17px] text-text" style={{ boxShadow: 'inset 0 0 0 1px var(--border)' }}>
            <Info size={14} className="text-primary shrink-0 mt-px" />
            <span><span className="text-fg font-medium">Next, about 3 minutes:</span> say what you want to grow, connect Google and your repository, then SuperRank builds your baseline.</span>
          </div>
        )}
        {errorBox}
      </form>
    );
    footer = (
      <>
        <Button variant="light" onClick={close}>Cancel</Button>
        <Button type="submit" form="new-project-form" variant="primary" disabled={!name.trim() || busy}>{busy ? 'Adding…' : 'Continue'}</Button>
      </>
    );
  }

  if (step === 2) {
    icon = Target;
    title = 'What do you want to grow?';
    subtitle = <>For <span className="text-fg font-medium">{project?.name || name.trim()}</span></>;
    body = <div className="space-y-4"><GoalFields value={goal} onChange={setGoal} />{errorBox}</div>;
    footer = (
      <>
        <Button variant="light" onClick={() => setStep(1)} disabled={busy}>Back</Button>
        <Button variant="light" onClick={() => setStep(3)} disabled={busy}>Skip for now</Button>
        <Button variant="primary" onClick={saveGoal} disabled={busy || !goalComplete(goal)}>{busy ? 'Saving…' : 'Save goal'}</Button>
      </>
    );
  }

  if (step === 3) {
    icon = Search;
    title = 'Connect Google';
    subtitle = 'So SuperRank can read your Search Console and Analytics.';
    const g = connect?.google;
    const scList = g?.searchConsole ?? [];
    const gaList = g?.analytics ?? [];
    const connected = Boolean(g?.connected);
    const picking = connected || useShared;                       // lists to choose from are showing
    const saved = Boolean(connect?.state?.google?.connected);     // the property pair is already stored
    const noneYet = picking && Array.isArray(scList) && Array.isArray(gaList) && (scList.length === 0 || gaList.length === 0);
    const returned = notice?.google === 'saved' ? 'We found your site in Google and connected it automatically.'
      : notice?.google === 'connected' ? 'Google is connected. Choose which of your sites this project is.' : null;

    // A function, called only once the lists exist: building this up front read `.length` of a list that
    // had not loaded yet and crashed the whole page to white.
    const siteHost = project?.websiteDomain || project?.website_domain || domain;
    const propertyPickers = () => (
      <div className="space-y-5">
        <div>
          <div className="flex items-center gap-2.5 mb-2.5">
            <span className="w-7 h-7 rounded-control bg-primary-tint text-primary grid place-items-center shrink-0"><Search size={15} /></span>
            <div className="min-w-0"><div className="text-sm font-semibold text-fg leading-4">Search Console</div><div className="text-xs text-faint mt-0.5">Where your site shows up in Google search</div></div>
          </div>
          {listError(scList) ? <Note tone="amber" icon={AlertTriangle}>{listError(scList)}</Note>
            : scList.length === 0 ? <Note tone="amber" icon={AlertTriangle}>This Google account has no Search Console sites. Use a different account, or add your site in Search Console first.</Note>
            : <PropertyList grid value={gsc} onPick={setGsc} siteHost={siteHost}
                items={scList.map((r) => { const dom = r.property.startsWith('sc-domain:'); return { id: r.property, title: hostOf(r.property), detail: dom ? 'Domain' : 'URL prefix', hint: r.property.replace(/^sc-domain:/, 'Domain: '), icon: dom ? Globe : Link2, domain: r.domain }; })} />}
        </div>
        <div>
          <div className="flex items-center gap-2.5 mb-2.5">
            <span className="w-7 h-7 rounded-control bg-primary-tint text-primary grid place-items-center shrink-0"><BarChart3 size={15} /></span>
            <div className="min-w-0"><div className="text-sm font-semibold text-fg leading-4">Google Analytics</div><div className="text-xs text-faint mt-0.5">Visits and what people do on your site</div></div>
          </div>
          {listError(gaList) ? <Note tone="amber" icon={AlertTriangle}>{listError(gaList)}</Note>
            : gaList.length === 0 ? <Note tone="amber" icon={AlertTriangle}>This Google account has no Analytics properties. Use a different account, or set up Analytics first.</Note>
            : <PropertyList grid value={ga4} onPick={setGa4} siteHost={siteHost}
                items={gaList.map((r) => ({ id: r.propertyId, title: r.name, detail: `ID ${r.propertyId}`, hint: `${r.name} · Property ${r.propertyId}${r.account ? ` · ${r.account}` : ''}`, icon: BarChart3, domain: r.domain || r.name }))} />}
        </div>
      </div>
    );

    body = (
      <div className="space-y-4">
        {returned && <Note tone="green" icon={Check}>{returned}</Note>}
        {notice?.error && <Note tone="red" icon={AlertTriangle}>{notice.error}</Note>}
        {connect === null ? (
          <div className="flex items-center gap-2 text-[13px] text-faint py-6 justify-center"><Loader2 size={15} className="animate-spin" />Checking your Google connection…</div>
        ) : connect.error ? <Note tone="red" icon={AlertTriangle}>{connect.error}</Note> : (
          <>
            {!picking && (
              <div className="rounded-card bg-white p-4" style={CARD}>
                <div className="text-[13px] font-medium text-fg">Sign in with the Google account that manages your website</div>
                <p className="mt-1 text-xs text-faint leading-[18px]">
                  Google opens in a new screen. You allow SuperRank to read Search Console and Analytics, then you come straight back. If your account has just one site we connect it for you; if it has several we ask which one is this project.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <Button variant="primary" onClick={startGoogle} disabled={busy || !g?.canConnect}>
                    <ExternalLink size={14} />{busy ? 'Opening Google…' : 'Connect with Google'}
                  </Button>
                  {!g?.canConnect && <span className="text-xs" style={{ color: '#8a5300' }}>Google sign-in is not set up on this server yet.</span>}
                </div>
              </div>
            )}

            {connected && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-text">
                <span className="inline-flex items-center gap-1.5"><Check size={14} style={{ color: 'var(--green)' }} />Connected{g.account ? <> as <b className="font-medium text-fg">{g.account}</b></> : null}</span>
                <button type="button" className="text-fg underline underline-offset-2 hover:text-primary" onClick={startGoogle} disabled={busy}>Use a different account</button>
                <button type="button" className="text-faint underline underline-offset-2 hover:text-fg" onClick={disconnectGoogle} disabled={busy}>Disconnect</button>
              </div>
            )}

            {picking && saved && !noneYet && (
              <div className="rounded-card bg-white p-3" style={CARD}>
                <div className="text-xs text-faint">Connected to</div>
                <div className="text-[13px] font-medium text-fg break-all">{connect.state.google.gscProperty}</div>
                <div className="text-[13px] text-text">Analytics property {connect.state.google.ga4PropertyId}</div>
              </div>
            )}
            {useShared && !connected && (
              <div className="flex items-center gap-2 rounded-control bg-muted px-3 py-2 text-xs text-text" style={{ boxShadow: 'inset 0 0 0 1px var(--border)' }}>
                <Info size={14} className="text-primary shrink-0" />
                <span className="flex-1 min-w-0"><span className="text-fg font-medium">Shared SuperRank Google account</span> · visible to SuperRank staff only</span>
                <button type="button" className="text-fg underline underline-offset-2 hover:text-primary shrink-0" onClick={() => { setUseShared(false); setGsc(null); setGa4(null); }}>Close</button>
              </div>
            )}
            {picking && !saved && propertyPickers()}
            {picking && saved && (
              <button type="button" className="text-[13px] text-fg underline underline-offset-2 hover:text-primary" onClick={() => { setGsc(null); setGa4(null); setConnect((c) => ({ ...c, state: { ...c.state, google: { ...c.state.google, connected: false } } })); }}>Choose a different site</button>
            )}

            {!picking && g?.sharedAvailable && (
              <p className="text-xs text-faint border-t pt-3" style={{ borderColor: 'var(--border)' }}>
                SuperRank staff only: <button type="button" className="underline underline-offset-2 hover:text-fg" onClick={showShared}>use the shared SuperRank Google account instead</button>
              </p>
            )}
          </>
        )}
        {errorBox}
      </div>
    );
    footer = (
      <>
        {picking && saved
          ? <Button variant="light" onClick={() => setStep(2)} disabled={busy}>Back</Button>
          : <><Button variant="light" onClick={() => setStep(2)} disabled={busy}>Back</Button><Button variant="light" onClick={() => setStep(4)} disabled={busy}>Skip for now</Button></>}
        {picking && saved
          ? <Button variant="primary" onClick={() => setStep(4)}>Continue</Button>
          : <Button variant="primary" onClick={saveGoogle} disabled={busy || !picking || !gsc || !ga4}>{busy ? 'Saving…' : 'Use this site'}</Button>}
      </>
    );
  }

  if (step === 4) {
    icon = MapPin;
    title = 'Your Business Profile';
    subtitle = 'Your listing on Google Maps and local search. This step is optional.';
    body = (
      <div className="space-y-4">
        <BusinessProfileFields choice={gbpChoice} setChoice={setGbpChoice} url={gbpUrl} setUrl={setGbpUrl} source={project?.id ? gbpSource(project.id) : null} outcome={notice?.gbp || null} />
        {errorBox}
      </div>
    );
    footer = (
      <>
        <Button variant="light" onClick={() => setStep(3)} disabled={busy}>Back</Button>
        <Button variant="light" onClick={() => setStep(5)} disabled={busy}>Skip for now</Button>
        <Button variant="primary" onClick={saveBusinessProfile} disabled={busy || !gbpReady(gbpChoice, gbpUrl)}>{busy ? 'Saving…' : 'Continue'}</Button>
      </>
    );
  }

  if (step === 5) {
    icon = GitBranch;
    title = 'Connect GitHub';
    subtitle = 'The repository the agent reads and opens pull requests against.';
    const repos = github?.repos || [];
    const ghError = github?.error;
    const installUrl = github?.installUrl;
    const restricted = Boolean(connect?.githubRestricted);
    const siteLabel = hostOf(project?.websiteDomain || project?.website_domain || domain).split('.')[0] || '';
    const clientSteps = [
      { n: 1, t: 'SuperRank links your repository', d: 'Our team connects the code behind your website. You do not install or paste anything.', state: 'Waiting on us', tone: 'amber' },
      { n: 2, t: 'The agent prepares fixes', d: 'It finds the right file, makes the change and opens a pull request.', state: 'After step 1', tone: 'grey' },
      { n: 3, t: 'You approve every change', d: 'Nothing is merged or published on your site without your approval.', state: 'Always', tone: 'green' },
    ];
    const ghCanConnect = Boolean(connect?.github?.canConnect);
    const connectCard = (who) => (
      <div className="rounded-card bg-white p-4" style={CARD}>
        <div className="flex items-start gap-3">
          <span className="w-9 h-9 rounded-control bg-fg text-white grid place-items-center shrink-0"><GitBranch size={17} /></span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-fg">{who === 'staff' ? 'Sign in with your own GitHub account' : 'Connect the repository behind your website'}</div>
            <p className="mt-1 text-xs text-faint leading-[18px]">
              {who === 'staff'
                ? 'You see the repositories your account can reach, choose the one for this project, and the agent works from it.'
                : 'GitHub opens in a new screen. You choose which repositories SuperRank may use, then come straight back and pick the one for this site. SuperRank only ever sees the ones you allow.'}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button variant="primary" onClick={startGithub} disabled={busy || !ghCanConnect}>
                <ExternalLink size={14} />{busy ? 'Opening GitHub…' : 'Connect with GitHub'}
              </Button>
              {!ghCanConnect && <span className="text-xs" style={{ color: '#8a5300' }}>GitHub sign-in is not set up on this server yet.</span>}
            </div>
          </div>
        </div>
      </div>
    );
    // Where the person is in the GitHub step, so a new user can see what is coming and what is left.
    const stageNow = !connect?.github?.connected || !mine?.signedIn ? 1 : mine.repos.length === 0 ? 2 : !repo ? 3 : 4;
    const stageChips = (
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" aria-label="GitHub steps">
        {['Connect GitHub', 'Install the app', 'Choose repository', 'Choose branch'].map((label, i) => {
          const n = i + 1, done = n < stageNow, on = n === stageNow;
          return (
            <li key={label} className="inline-flex items-center gap-1.5">
              {i > 0 && <span className="text-faint">›</span>}
              <span className={`w-4 h-4 rounded-full grid place-items-center text-[10px] font-semibold ${done ? 'bg-primary text-white' : on ? 'bg-fg text-white' : 'bg-muted text-faint'}`}>{done ? <Check size={9} strokeWidth={3} /> : n}</span>
              <span className={on ? 'font-medium text-fg' : done ? 'text-text' : 'text-faint'}>{label}</span>
            </li>
          );
        })}
      </ol>
    );
    const mineLoaded = mine && mine.signedIn;
    const mineBlock = () => {
      if (!connect?.github?.connected) return connectCard(restricted ? 'client' : 'staff');
      if (mine === null) return <div className="flex items-center gap-2 text-[13px] text-faint py-6 justify-center"><Loader2 size={15} className="animate-spin" />Reading your repositories…</div>;
      if (!mine.signedIn) return <>{mine.error && <Note tone="amber" icon={AlertTriangle}>{mine.error}</Note>}{connectCard(restricted ? 'client' : 'staff')}</>;
      return (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-text">
            <span className="inline-flex items-center gap-1.5"><Check size={14} style={{ color: 'var(--green)' }} />Signed in to GitHub{mine.login ? <> as <b className="font-medium text-fg">{mine.login}</b></> : null}</span>
            <button type="button" className="text-fg underline underline-offset-2 hover:text-primary" onClick={startGithub} disabled={busy}>Use a different account</button>
          </div>
          {mine.repos.length === 0 ? (
            <div className="rounded-card bg-white p-4" style={CARD}>
              <div className="flex items-start gap-3">
                <span className="w-9 h-9 rounded-control bg-primary-tint text-primary grid place-items-center shrink-0"><Download size={17} /></span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold text-fg">Next: install the SuperRank app</div>
                  <p className="mt-1 text-xs text-faint leading-[18px]">
                    You are signed in, but SuperRank cannot see any repository yet. GitHub asks you to install the app and tick the repositories it may use. It opens in this tab and brings you back here, where your repositories will be waiting.
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    {mine.installUrl
                      ? <a href={mine.installUrl} className="btn btn--primary"><ExternalLink size={14} />Install SuperRank on GitHub</a>
                      : <span className="text-xs" style={{ color: '#8a5300' }}>The SuperRank app address is not set up on this server yet.</span>}
                    <button type="button" className="text-[13px] text-faint underline underline-offset-2 hover:text-fg" onClick={() => { setMine(null); }}>I have installed it, check again</button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <PropertyList value={repo} onPick={setRepo} noun="repositories"
              items={mine.repos.map((r) => ({
                id: r.fullName, title: r.name, detail: `${r.owner} · branch ${r.defaultBranch}`, badge: r.private ? 'Private' : 'Public',
                best: Boolean(siteLabel) && r.name.toLowerCase().includes(siteLabel.toLowerCase()), bestLabel: 'Looks like this site',
              }))} />
          )}
          {repo && (
            <div className="rounded-card bg-white p-3 space-y-3" style={CARD}>
              <div className="text-xs font-medium text-fg">Branches for <span className="font-semibold">{repo}</span></div>
              {branches === null ? (
                <div className="flex items-center gap-2 text-xs text-faint"><Loader2 size={13} className="animate-spin" />Reading branches…</div>
              ) : (
                <>
                  {branches.error && <Note tone="amber" icon={AlertTriangle}>{branches.error}</Note>}
                  <label className="fld">
                    <span className="fld__label">Production branch</span>
                    {branches.names.length > 0
                      ? <select value={branch} onChange={(e) => setBranch(e.target.value)}>{branches.names.map((n) => <option key={n} value={n}>{n}{n === branches.defaultBranch ? ' (default)' : ''}</option>)}</select>
                      : <input type="text" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />}
                    <span className="fld__hint">The live branch. Each day's work is prepared from it.</span>
                  </label>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-fg">Review on a stage branch first</span>
                      <span className="block text-xs text-faint">Pull requests open into the stage branch; you promote it to main yourself.</span>
                    </span>
                    <input type="checkbox" role="switch" checked={useStage} onChange={(e) => setUseStage(e.target.checked)} className="shrink-0 w-4 h-4" />
                  </label>
                  {useStage && (
                    <label className="fld">
                      <span className="fld__label">Stage branch</span>
                      {branches.names.filter((n) => n !== branch).length > 0
                        ? <select value={branches.names.includes(stage) ? stage : ''} onChange={(e) => setStage(e.target.value)}>{!branches.names.includes(stage) && <option value="">Choose a branch</option>}{branches.names.filter((n) => n !== branch).map((n) => <option key={n} value={n}>{n}</option>)}</select>
                        : <input type="text" value={stage} onChange={(e) => setStage(e.target.value)} placeholder="stage" />}
                      <span className="fld__hint">It must already exist in the repository.</span>
                    </label>
                  )}
                </>
              )}
            </div>
          )}
          {mine.installUrl && mine.repos.length > 0 && (
            <a href={mine.installUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-fg hover:text-primary"><ExternalLink size={13} />A repository missing? Add it on GitHub</a>
          )}
        </div>
      );
    };
    // The short guide under the GitHub connection, the same for staff and clients.
    const whatNext = (
      <div className="rounded-card bg-muted px-4 py-3" style={{ boxShadow: 'inset 0 0 0 1px var(--border)' }}>
        <div className="text-xs font-medium text-fg mb-2">What happens next</div>
        <ol className="space-y-1.5">
          {[['Connect GitHub', 'Sign in to GitHub and allow SuperRank on the repositories you choose.'], ['Choose the repository and branch', 'Only the ones you allow are visible to SuperRank.'], ['The agent prepares fixes', 'Every day it finds the right file, makes the change and opens a pull request.'], ['You approve every change', 'Nothing is merged or published without your approval.']].map(([t, d], i) => (
            <li key={t} className="flex items-start gap-2.5 text-xs leading-[17px]">
              <span className="w-4 h-4 mt-px rounded-full bg-white text-text grid place-items-center text-[10px] font-semibold shrink-0" style={{ boxShadow: 'inset 0 0 0 1px var(--border-2)' }}>{i + 1}</span>
              <span className="min-w-0"><span className="text-fg font-medium">{t}.</span> <span className="text-faint">{d}</span></span>
            </li>
          ))}
        </ol>
      </div>
    );
    body = restricted ? (
      <div className="space-y-4">
        {notice?.error && notice?.fromGithub && <Note tone="red" icon={AlertTriangle}>{notice.error}</Note>}
        {stageChips}
        {mineBlock()}
        {whatNext}
      </div>
    ) : (
      <div className="space-y-4">
        {github === null ? (
          <div className="flex items-center gap-2 text-[13px] text-faint py-6 justify-center"><Loader2 size={15} className="animate-spin" />Reading your repositories…</div>
        ) : (
          <>
            {effSource === 'mine' && <>{stageChips}{mineBlock()}{whatNext}</>}
            {effSource === 'app' && (<>
            <div className="flex items-center gap-2 rounded-control bg-muted px-3 py-2 text-xs text-text" style={{ boxShadow: 'inset 0 0 0 1px var(--border)' }}>
              <Info size={14} className="text-primary shrink-0" />
              <span className="flex-1 min-w-0"><span className="text-fg font-medium">SuperRank GitHub app</span> · every repository it can reach · visible to SuperRank staff only</span>
            </div>
            {ghError && <Note tone="amber" icon={AlertTriangle}>{ghError}</Note>}
            {repos.length === 0 ? (
              <Note tone="amber" icon={AlertTriangle}>
                No repositories yet.{' '}
                {installUrl ? <>Install the SuperRank app on the repository, then reopen this step.</> : <>The SuperRank GitHub app is not set up on this server yet.</>}
              </Note>
            ) : (
              <PropertyList value={repo} onPick={setRepo} noun="repositories"
                items={repos.map((r) => ({
                  id: r.fullName, title: r.name, detail: `${r.owner} · branch ${r.defaultBranch}`, badge: r.private ? 'Private' : 'Public',
                  best: Boolean(siteLabel) && r.name.toLowerCase().includes(siteLabel.toLowerCase()), bestLabel: 'Looks like this site',
                }))} />
            )}
            {repos.length > 0 && (
              <div className="rounded-card bg-white px-3 py-2.5" style={CARD}>
                <label className="flex items-center gap-3 cursor-pointer">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-fg">Review on a stage branch first</span>
                    <span className="block text-xs text-faint">Pull requests open into the stage branch; you promote it to main yourself.</span>
                  </span>
                  <input type="checkbox" role="switch" checked={useStage} onChange={(e) => setUseStage(e.target.checked)} className="shrink-0 w-4 h-4" />
                </label>
                {useStage && (
                  <div className="mt-2.5"><Field label="Stage branch" value={stage} onChange={(e) => setStage(e.target.value)} placeholder="stage" hint="It must already exist in the repository." /></div>
                )}
              </div>
            )}
            {installUrl && (
              <a href={installUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-fg hover:text-primary">
                <ExternalLink size={13} />{repos.length === 0 ? 'Install the SuperRank app on GitHub' : 'A repository missing? Add it on GitHub'}
              </a>
            )}
            {repos.length > 0 && installUrl && (
              <button type="button" className="ml-3 text-[13px] text-faint underline underline-offset-2 hover:text-fg" onClick={() => { setGithub(null); api.project.connect.githubRepos(project.id, { fresh: true }).then(setGithub).catch((err) => setGithub({ error: err.message, repos: [], installations: [] })); }}>Refresh list</button>
            )}
            </>)}
          </>
        )}
        {errorBox}
      </div>
    );
    footer = (
      <>
        <Button variant="light" onClick={() => setStep(4)} disabled={busy}>Back</Button>
        {restricted ? (
          <>
            <Button variant="light" onClick={() => setStep(6)} disabled={busy}>Skip for now</Button>
            {mineLoaded && mine.repos.length > 0 && <Button variant="primary" onClick={saveGithub} disabled={busy || !repo || (useStage && !stage.trim())}>{busy ? 'Connecting…' : 'Connect repository'}</Button>}
          </>
        ) : (
          <Button variant="primary" onClick={saveGithub} disabled={busy || !repo || (useStage && !stage.trim()) || (effSource === 'mine' && !mineLoaded)}>{busy ? 'Connecting…' : 'Connect repository'}</Button>
        )}
      </>
    );
  }

  if (step === 6) {
    icon = baseline === 'done' ? Check : Loader2;
    title = baseline === 'done' ? `${project?.name} is ready` : baseline === 'waiting' ? `${project?.name} is created` : 'Building your baseline';
    subtitle = baseline === 'done' ? 'Here is where things stand.' : baseline === 'waiting' ? 'Here is what is left before it starts collecting data.' : 'This takes a few minutes. You can close this and it keeps going.';
    const state = connect?.state;
    const rows = [
      { ok: true, label: 'Project created', detail: `${project?.name} in ${workspace?.name}` },
      { ok: Boolean(goal && goalComplete(goal)), label: 'Goal set', detail: goal && goalComplete(goal) ? 'Tracked on your Overview' : 'Not set yet — add it in Account settings → Project' },
      { ok: Boolean(state?.google?.connected), label: 'Google Search Console and Analytics', detail: state?.google?.connected ? `${state.google.gscProperty} · property ${state.google.ga4PropertyId}` : 'Not connected yet' },
      {
        ok: Boolean(state?.github?.connected),
        label: 'GitHub',
        detail: state?.github?.connected
          ? `${state.github.repo}${githubChecks?.techStack ? ` · ${githubChecks.techStack}` : ''}${githubChecks?.gaps === 0 ? ' · ready for fixes' : githubChecks?.gaps > 0 ? ` · ${githubChecks.gaps} thing${githubChecks.gaps === 1 ? '' : 's'} still to configure` : ''}`
          : 'Not connected yet',
      },
      {
        ok: baseline === 'done', pending: baseline === 'running', label: 'Baseline report',
        detail: baseline === 'running' ? 'Collecting your data and running the first analysis…' : baseline === 'done' ? 'Done. Your Overview has real numbers now.' : baseline === 'waiting' ? 'Starts once Google is connected.' : 'Did not finish. SuperRank can run it again.',
      },
    ];
    body = (
      <div className="space-y-4">
        <div className="tray"><div className="tray-card">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-0">
              <span className="w-6 h-6 rounded-full grid place-items-center shrink-0"
                style={r.pending ? { background: 'var(--muted)', color: 'var(--faint)' } : r.ok ? { background: 'var(--green-tint)', color: 'var(--green)' } : { background: '#fdf3e1', color: '#8a5300' }}>
                {r.pending ? <Loader2 size={12} className="animate-spin" /> : r.ok ? <Check size={13} strokeWidth={2.5} /> : <AlertTriangle size={12} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-fg">{r.label}</span>
                <span className="block text-xs text-faint">{r.detail}</span>
              </span>
            </div>
          ))}
        </div></div>
        {errorBox}
      </div>
    );
    footer = (
      <>
        <Button variant="light" onClick={close}>Close</Button>
        <Button variant="primary" onClick={() => { const p = project; close(); onOpenProject?.(p); }} disabled={!project}>Go to {project?.name}</Button>
      </>
    );
  }

  return (
    <Modal isOpen={isOpen} onClose={close} icon={icon} title={title} subtitle={subtitle} maxWidth="max-w-[560px]" footer={footer} anchor="top">
      <Stepper step={step} />
      {/* A floor under every step's height, so a list loading in does not make the popup jump. */}
      <div>{body}</div>
    </Modal>
  );
}
