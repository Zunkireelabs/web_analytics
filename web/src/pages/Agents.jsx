import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Play } from 'lucide-react';
import { api, timeAgo } from '../api.js';
import PageIntro from '../components/layout/PageIntro.jsx';
import Badge from '../components/Badge.jsx';
import Button from '../components/Button.jsx';
import useLiveAgents from '../hooks/useLiveAgents.js';
import { buildGroups, buildAreas, runProgress, currentArea, groupIdFor, AGENT_PATH } from '../lib/agent-groups.js';

// ONE agent's page (SEO, AI and GEO, Content, Executive, Accessibility or Security): what it is doing right now, what it looks after,
// what it found and when it last ran, in plain words. The specialists underneath are never listed, and the other agents are not shown
// here: the sidebar is how you move between them. Live: it follows the same stream as the sidebar.
export default function Agents() {
  const [params] = useSearchParams();
  const groupId = params.get('group');
  const { agents, activity, running, refresh } = useLiveAgents({ activityLimit: 40 });
  const groups = useMemo(() => buildGroups(agents, running), [agents, running]);
  const g = groups.find((x) => x.id === groupId) || null;
  const [queued, setQueued] = useState(() => new Set());
  const [error, setError] = useState(null);

  const areas = useMemo(() => (g ? buildAreas(g, queued) : []), [g, queued]);
  const progress = runProgress(areas, queued);
  const now = currentArea(areas);
  const working = Boolean(now);
  const found = areas.reduce((n, a) => n + a.found, 0);
  const recent = (activity || []).filter((a) => groupIdFor(a.category) === groupId).slice(0, 5);

  // "Run now" asks each specialist of this agent to run, one after another, and ticks the areas off as they finish.
  const runNow = async () => {
    if (!g || queued.size) return;
    const ids = g.agents.map((a) => a.id);
    setQueued(new Set(ids)); setError(null);
    for (const id of ids) {
      try { await api.runAgent(id); } catch (e) { setError(e.message || 'One check could not run.'); }
      setQueued((q) => { const n = new Set(q); n.delete(id); return n; });
    }
    refresh();
  };

  if (agents === null) return <Shell title="Agent" subtitle="Loading…"><div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-[64px] rounded-card bg-muted animate-pulse" />)}</div></Shell>;
  if (!g) return <Shell title="Agent" subtitle="This agent has nothing to show yet."><Link to={AGENT_PATH} className="underline underline-offset-2 text-sm">Back to the systems map</Link></Shell>;

  return (
    <Shell title={`${g.label} agent`} subtitle={`Looks after ${g.blurb.charAt(0).toLowerCase()}${g.blurb.slice(1)}`.replace(/^Looks after looks after /, 'Looks after ')} back>
      <div className={`rounded-card bg-white px-5 py-4 ${working ? '' : ''}`} style={{ boxShadow: working ? '0 0 0 2px var(--primary), 0 0 0 6px var(--primary-tint)' : 'var(--card-shadow)' }} aria-live="polite">
        <div className="flex items-center gap-3.5">
          <span className="relative w-3 h-3 shrink-0">
            {working && <span className="absolute inset-0 rounded-full bg-primary animate-ping opacity-60" />}
            <span className={`absolute inset-0 rounded-full ${working ? 'bg-primary' : g.state === 'attention' ? 'bg-[#b8860b]' : 'bg-[#1a7f4b]'}`} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[19px] font-semibold tracking-[-0.02em] text-fg">{working ? 'Working now' : g.state === 'attention' ? 'Needs a look' : 'Idle'}</div>
            <div className="text-sm text-text mt-0.5">
              {working ? `${now.name}: ${now.what.charAt(0).toLowerCase()}${now.what.slice(1)}`
                : g.lastRunAt ? `Last ran ${timeAgo(g.lastRunAt)} · ${found > 0 ? `${found} ${found === 1 ? 'thing' : 'things'} found` : 'nothing to fix'}` : 'Has not run yet'}
            </div>
          </div>
          {progress && <div className="text-[26px] font-semibold tracking-[-0.03em] tnum text-fg">{progress.done}<span className="text-[15px] font-medium text-faint"> of {progress.n}</span></div>}
          {!working && <Button variant="light" onClick={runNow} disabled={queued.size > 0}><Play size={11} fill="currentColor" /> Run now</Button>}
        </div>
        {progress && <div className="mt-3.5 h-[7px] rounded-full bg-muted overflow-hidden"><div className="h-full rounded-full bg-primary transition-[width] duration-700" style={{ width: `${Math.round((progress.done / progress.n) * 100)}%` }} /></div>}
        {error && <div className="mt-3 text-[13px] text-[#b42318]">{error}</div>}
      </div>

      <div className="tray mt-4">
        <div className="px-2.5 pt-1.5 pb-1"><h2 className="text-[13px] font-semibold text-fg">What it looks after</h2><p className="text-xs text-faint">{working ? 'Live' : 'As of the last run'}</p></div>
        <div className="tray-card overflow-hidden">
          {areas.map((a) => (
            <div key={a.name} className={`flex items-center gap-3 px-4 py-3.5 border-t border-border first:border-t-0 ${a.state === 'running' ? 'bg-primary-tint/50' : ''}`}>
              <AreaIcon state={a.state} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-fg">{a.name}</span>
                <span className="block text-xs text-faint">{a.what}</span>
              </span>
              <span className={`text-[13px] shrink-0 ${a.state === 'done' && a.found > 0 ? 'text-[#8a5300] font-medium' : 'text-faint'}`}>
                {a.state === 'running' ? 'Checking…' : a.state === 'waiting' ? 'Waiting' : a.state === 'never' ? 'Not run yet' : a.failed ? 'Needs a look' : a.found > 0 ? `${a.found} found` : 'All good'}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-3 mt-4 lg:grid-cols-2 items-start">
        <div className="tray">
          <div className="px-2.5 pt-1.5 pb-1"><h2 className="text-[13px] font-semibold text-fg">What it found</h2><p className="text-xs text-faint">From its latest run</p></div>
          <div className="tray-card overflow-hidden">
            {areas.filter((a) => a.found > 0).map((a) => (
              <Link key={a.name} to="/action-center" className="flex items-center gap-3 px-4 py-3 border-t border-border first:border-t-0 hover:bg-[#fafafa]">
                <span className="min-w-0 flex-1 text-sm font-medium text-fg">{a.name}</span>
                <Badge tone="amber" className="shrink-0">{a.found} found</Badge>
                <span className="text-[13px] font-medium text-primary-strong shrink-0">Open →</span>
              </Link>
            ))}
            {!areas.some((a) => a.found > 0) && <div className="px-4 py-6 text-[13px] text-text">Nothing to fix right now.</div>}
          </div>
        </div>
        <div className="tray">
          <div className="px-2.5 pt-1.5 pb-1"><h2 className="text-[13px] font-semibold text-fg">Recent runs</h2><p className="text-xs text-faint">Newest first</p></div>
          <div className="tray-card overflow-hidden">
            {recent.map((r, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3 border-t border-border first:border-t-0">
                <span className="min-w-0 flex-1 text-[13px] text-fg truncate">{r.status === 'ok' ? r.label : `Attempted: ${r.label.charAt(0).toLowerCase()}${r.label.slice(1)}`}</span>
                <span className="text-xs text-faint shrink-0 tnum">{timeAgo(r.createdAt)}</span>
              </div>
            ))}
            {!recent.length && <div className="px-4 py-6 text-[13px] text-text">No runs yet.</div>}
          </div>
        </div>
      </div>
    </Shell>
  );
}

function Shell({ title, subtitle, back, children }) {
  return (
    <div className="max-w-[1100px] mx-auto px-4 md:px-6 pt-6 pb-12 fade-up">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1"><PageIntro title={title} subtitle={subtitle} /></div>
        {back && <Link to={AGENT_PATH} className="mt-2 text-[13px] text-text underline underline-offset-2 hover:text-fg shrink-0">Systems map</Link>}
      </div>
      {children}
    </div>
  );
}

function AreaIcon({ state }) {
  if (state === 'running') return <span className="w-5 h-5 rounded-full border-[2.5px] border-primary-ring border-t-primary animate-spin shrink-0" aria-label="Checking" />;
  if (state === 'done') return <span className="w-5 h-5 rounded-full grid place-items-center text-[11px] font-bold shrink-0" style={{ background: 'var(--green-tint)', color: 'var(--green)' }} aria-label="Checked">✓</span>;
  return <span className="w-5 h-5 rounded-full shrink-0" style={{ boxShadow: 'inset 0 0 0 2px var(--input)' }} aria-label={state === 'waiting' ? 'Waiting' : 'Not run yet'} />;
}
