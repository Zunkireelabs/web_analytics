import { useEffect, useState } from 'react';
import { Check, FolderPlus, GitBranch, Globe, Loader2, Search, BarChart3, Target, AlertTriangle, ExternalLink } from 'lucide-react';
import { api } from '../../api.js';
import Modal from '../Modal.jsx';
import Field from '../Field.jsx';
import Button from '../Button.jsx';
import Badge from '../Badge.jsx';
import GoalFields from './GoalFields.jsx';
import { DEFAULT_GOAL, goalComplete } from '../../lib/workspace.js';

// Adding a project, end to end, with no staff step anywhere in it:
//
//   1 Details   name + website address  (the project is created here, so the
//                                        steps below have something to attach to)
//   2 Goal      the presets or your own words
//   3 Google    PICK a Search Console property and a GA4 property from the
//               lists our Google account can actually see
//   4 GitHub    PICK the repository from the list our GitHub app can reach.
//               Required: the agent reads the site's code to make a fix, so a
//               project without a repo has nothing it can open a PR against.
//   5 Baseline  runs by itself and lands on the project
//
// Nothing is typed in that could be mistyped — the two connect steps are
// pickers over real listings, so a property or repo that is missing is honest
// evidence the access isn't there yet, visible BEFORE the baseline runs rather
// than as a failure after it.
//
// Closing part-way is safe: the project already exists, and the Projects page
// shows "Finish setting up" on it, which reopens this at the step still owed.
const STEPS = ['Details', 'Goal', 'Google', 'GitHub', 'Baseline'];

const CARD = { boxShadow: '0 0 0 1px var(--input), 0 1px 2px rgba(0,0,0,.03)' };
const CARD_ON = { boxShadow: '0 0 0 1px var(--primary), 0 0 0 4px var(--primary-tint)' };

function Stepper({ step }) {
  return (
    <div className="flex items-center gap-2 mb-5">
      {STEPS.map((label, i) => {
        const n = i + 1, on = n === step, done = n < step;
        return (
          <div key={label} className="flex items-center gap-2 min-w-0">
            {i > 0 && <span className="w-4 h-px shrink-0" style={{ background: 'var(--border-2)' }} />}
            <span className={`w-5 h-5 rounded-full grid place-items-center text-[11px] font-medium shrink-0 ${done ? 'bg-primary-tint text-primary' : on ? 'bg-fg text-white' : 'bg-muted text-faint'}`}>
              {done ? <Check size={11} strokeWidth={3} /> : n}
            </span>
            {/* On a phone only the current step keeps its name; the numbers carry the rest. */}
            <span className={`text-xs truncate ${on ? 'font-medium text-fg' : 'hidden sm:inline text-faint'}`}>{label}</span>
          </div>
        );
      })}
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
export default function NewProjectModal({ workspace, project: existing = null, isOpen, onClose, onChanged, onOpenProject, startStep = null, notice = null }) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
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
  const [baseline, setBaseline] = useState(existing ? 'idle' : 'idle'); // idle | running | done | failed

  // Reopening on an existing project: start at the first step it still owes.
  useEffect(() => {
    if (!isOpen || !existing) return;
    setProject(existing);
    setName(existing.name || '');
    setDomain(existing.domain || '');
    if (existing.goal) setGoal(existing.goal);
    setStep(startStep || (!existing.goal ? 2 : 3));
  }, [isOpen, existing?.id]);

  // The two listings are fetched once the project exists, so steps 3 and 4 are
  // already populated when they are reached.
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
    } catch (err) {
      setConnect({ error: err.message || 'Could not read what there is to connect.' });
    }
  };
  useEffect(() => { if (isOpen && project?.id && step >= 3 && !connect) loadConnect(project.id); }, [isOpen, project?.id, step]);
  // GitHub's list is slow (one call per installation), so it loads only once that step is reached.
  useEffect(() => {
    if (!isOpen || !project?.id || step !== 4 || github) return;
    api.project.connect.githubRepos(project.id).then(setGithub).catch((err) => setGithub({ error: err.message || 'GitHub could not be read right now.', repos: [], installations: [] }));
  }, [isOpen, project?.id, step]);

  const close = () => {
    const created = project;
    setStep(1); setName(''); setDomain(''); setGoal(DEFAULT_GOAL); setProject(null);
    setConnect(null); setGithub(null); setGsc(null); setGa4(null); setRepo(null); setGithubChecks(null); setUseStage(false); setStage('stage'); setUseShared(false);
    setBaseline('idle'); setError(null); setBusy(false);
    onClose(created);
  };

  const run = async (fn) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (err) { setError(err.message || 'That did not work. Try again.'); } finally { setBusy(false); }
  };

  const createProject = () => run(async () => {
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

  const saveGithub = () => run(async () => {
    const [owner, repoName] = String(repo).split('/');
    const r = await api.project.connect.github(project.id, { repoOwner: owner, repoName, ...(useStage && stage.trim() ? { prTargetBranch: stage.trim() } : {}) });
    setConnect((c) => ({ ...c, state: r.state }));
    setGithubChecks({ ...r.checks, techStack: r.techStack });
    setStep(5);
  });

  const runBaseline = async () => {
    setBaseline('running'); setError(null);
    try {
      await api.project.baseline(project.id);
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
    if (!isOpen || step !== 5 || baseline !== 'idle' || !project?.id || connect === null) return;
    if (connect?.state?.google?.connected) runBaseline();
    else setBaseline('waiting');
  }, [isOpen, step, baseline, project?.id, connect]);

  const errorBox = error && <Note tone="red" icon={AlertTriangle}>{error}</Note>;
  const listError = (list) => (list && !Array.isArray(list) ? list.error : null);

  // ───────── step bodies ─────────

  let body = null, footer = null, title = 'Add project', subtitle = null, icon = FolderPlus;

  if (step === 1) {
    subtitle = <>To <span className="text-fg font-medium">{workspace?.name}</span></>;
    body = (
      <form id="new-project-form" onSubmit={(e) => { e.preventDefault(); createProject(); }} className="space-y-4">
        <Field label="Project name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Blog" required autoFocus />
        <label className="fld">
          <span className="fld__label">Website address</span>
          <div className="relative">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"><Globe size={14} /></span>
            <input type="text" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="blog.acme.com" style={{ paddingLeft: 32 }} />
          </div>
          <span className="fld__hint">Just the address, like acme.com. We use it to find the right Google property for you.</span>
        </label>
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
    const propertyPickers = () => (
      <div className="space-y-5">
        <div>
          <div className="flex items-center gap-2 text-[13px] font-medium text-fg mb-2"><Search size={14} className="text-faint" />Search Console property</div>
          {listError(scList) ? <Note tone="amber" icon={AlertTriangle}>{listError(scList)}</Note>
            : scList.length === 0 ? <Note tone="amber" icon={AlertTriangle}>This Google account has no Search Console sites. Use a different account, or add your site in Search Console first.</Note>
            : <div className="grid gap-2 max-h-[180px] overflow-y-auto pr-0.5">
                {scList.map((r) => <PickRow key={r.property} on={gsc === r.property} title={r.property} detail={r.domain} badge={r.permission === 'siteOwner' ? 'Owner' : null} onClick={() => setGsc(r.property)} />)}
              </div>}
        </div>
        <div>
          <div className="flex items-center gap-2 text-[13px] font-medium text-fg mb-2"><BarChart3 size={14} className="text-faint" />Analytics property</div>
          {listError(gaList) ? <Note tone="amber" icon={AlertTriangle}>{listError(gaList)}</Note>
            : gaList.length === 0 ? <Note tone="amber" icon={AlertTriangle}>This Google account has no Analytics properties. Use a different account, or set up Analytics first.</Note>
            : <div className="grid gap-2 max-h-[180px] overflow-y-auto pr-0.5">
                {gaList.map((r) => <PickRow key={r.propertyId} on={ga4 === r.propertyId} title={r.name} detail={`Property ${r.propertyId}${r.account ? ` · ${r.account}` : ''}`} onClick={() => setGa4(r.propertyId)} />)}
              </div>}
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
            {picking && !saved && propertyPickers()}
            {picking && saved && (
              <button type="button" className="text-[13px] text-fg underline underline-offset-2 hover:text-primary" onClick={() => { setGsc(null); setGa4(null); setConnect((c) => ({ ...c, state: { ...c.state, google: { ...c.state.google, connected: false } } })); }}>Choose a different site</button>
            )}

            {!picking && g?.sharedAvailable && (
              <p className="text-xs text-faint">
                SuperRank staff: <button type="button" className="underline underline-offset-2 hover:text-fg" onClick={showShared}>use the shared SuperRank Google account instead</button>
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
          : <Button variant="light" onClick={() => setStep(4)} disabled={busy}>Skip for now</Button>}
        {picking && saved
          ? <Button variant="primary" onClick={() => setStep(4)}>Continue</Button>
          : <Button variant="primary" onClick={saveGoogle} disabled={busy || !picking || !gsc || !ga4}>{busy ? 'Saving…' : 'Use this site'}</Button>}
      </>
    );
  }

  if (step === 4) {
    icon = GitBranch;
    title = 'Connect GitHub';
    subtitle = 'The repository the agent reads and opens pull requests against.';
    const repos = github?.repos || [];
    const ghError = github?.error;
    const installUrl = github?.installUrl;
    const restricted = Boolean(connect?.githubRestricted);
    body = restricted ? (
      <div className="space-y-4">
        <Note icon={GitBranch}>
          The agent needs your site's code to make fixes, and SuperRank links your repository for you for now. It is on our setup list, and nothing is changed on your site until it is linked and you approve each pull request.
        </Note>
      </div>
    ) : (
      <div className="space-y-4">
        {github === null ? (
          <div className="flex items-center gap-2 text-[13px] text-faint py-6 justify-center"><Loader2 size={15} className="animate-spin" />Reading your repositories…</div>
        ) : (
          <>
            <Note icon={GitBranch}>
              The agent needs the site's own code: it finds the page's file, makes the change there and opens a pull request. Nothing merges without your approval.
            </Note>
            {ghError && <Note tone="amber" icon={AlertTriangle}>{ghError}</Note>}
            {repos.length === 0 ? (
              <Note tone="amber" icon={AlertTriangle}>
                No repositories yet.{' '}
                {installUrl ? <>Install the SuperRank app on the repository, then reopen this step.</> : <>The SuperRank GitHub app is not set up on this server yet.</>}
              </Note>
            ) : (
              <div className="grid gap-2 max-h-[240px] overflow-y-auto pr-0.5">
                {repos.map((r) => (
                  <PickRow key={r.fullName} on={repo === r.fullName} title={r.fullName} detail={`Default branch ${r.defaultBranch}`} badge={r.private ? 'Private' : null} onClick={() => setRepo(r.fullName)} />
                ))}
              </div>
            )}
            {repos.length > 0 && (
              <div className="rounded-card bg-white p-3" style={CARD}>
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input type="checkbox" checked={useStage} onChange={(e) => setUseStage(e.target.checked)} className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-fg">We review changes on a stage branch first</span>
                    <span className="block text-xs text-faint mt-0.5">Fixes are prepared from your main branch, and the pull request opens into the stage branch. You promote it to main yourself.</span>
                  </span>
                </label>
                {useStage && (
                  <div className="mt-2.5 sm:pl-6"><Field label="Stage branch" value={stage} onChange={(e) => setStage(e.target.value)} placeholder="stage" hint="It must already exist in the repository." /></div>
                )}
              </div>
            )}
            {installUrl && (
              <a href={installUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-fg hover:text-primary">
                <ExternalLink size={13} />{repos.length === 0 ? 'Install the SuperRank app on GitHub' : 'A repository missing? Add it on GitHub'}
              </a>
            )}
          </>
        )}
        {errorBox}
      </div>
    );
    footer = (
      <>
        <Button variant="light" onClick={() => setStep(3)} disabled={busy}>Back</Button>
        {restricted ? (
          <Button variant="primary" onClick={() => setStep(5)}>Continue</Button>
        ) : (
          <Button variant="primary" onClick={saveGithub} disabled={busy || !repo || (useStage && !stage.trim())}>{busy ? 'Connecting…' : 'Connect repository'}</Button>
        )}
      </>
    );
  }

  if (step === 5) {
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
    <Modal isOpen={isOpen} onClose={close} icon={icon} title={title} subtitle={subtitle} maxWidth="max-w-[560px]" footer={footer}>
      <Stepper step={step} />
      {body}
    </Modal>
  );
}
