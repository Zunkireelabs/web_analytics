import { Link, useLocation } from 'react-router-dom';
import { Network } from 'lucide-react';
import { timeAgo } from '../api.js';
import useLiveAgents from '../hooks/useLiveAgents.js';
import { buildGroups, buildAreas, currentArea, AGENT_PATH } from '../lib/agent-groups.js';

// The sidebar body when the toggle is on Agent: the systems map (the main page of the Agent view), then the six agent
// groups only (not the ~38 agents), live. A group opens its agents in the main area. A group is "running" only while the server has a real run in progress.
export default function SidebarAgents() {
  const loc = useLocation();
  const current = new URLSearchParams(loc.search).get('group');
  const onOverview = loc.pathname === AGENT_PATH && !current && !new URLSearchParams(loc.search).get('view');
  const { agents, running } = useLiveAgents({ activityLimit: 1 });
  const groups = buildGroups(agents, running);
  const runningNow = groups.reduce((n, g) => n + g.runningCount, 0);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <nav className="flex-1 overflow-y-auto px-3 py-1.5 custom-scrollbar" aria-live="polite">
        <Row to={AGENT_PATH} active={onOverview} icon={<Network size={15} strokeWidth={1.75} />} title="Systems map"
          sub={runningNow > 0 ? `${runningNow} working now` : 'All quiet right now'} pulse={runningNow > 0} />

        <div className="px-2.5 pt-3.5 pb-1 text-[11px] font-medium tracking-[.08em] uppercase text-faint">Your agents</div>
        {agents === null ? (
          <div className="space-y-1.5 px-1 pt-1">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-[46px] rounded-control bg-muted animate-pulse" />)}</div>
        ) : groups.map((g) => {
          const now = currentArea(buildAreas(g));
          const found = g.agents.reduce((n, a) => n + (a.lastRunFindings || 0), 0);
          return (
            <Row key={g.id} to={`${AGENT_PATH}?group=${g.id}`} active={current === g.id} title={g.label} pulse={g.state === 'running'}
              dot={g.state === 'attention' ? 'bg-[#b8860b]' : null}
              sub={g.state === 'running' ? `Working now${now ? ` · ${now.name.toLowerCase()}` : ''}`
                : g.state === 'attention' ? 'Needs a look'
                : `Idle${g.lastRunAt ? ` · ${timeAgo(g.lastRunAt)}` : ''}`}
              count={found > 0 ? found : null} />
          );
        })}
      </nav>

    </div>
  );
}

function Row({ to, active, icon, title, sub, count, pulse, dot }) {
  return (
    <Link to={to} aria-current={active ? 'page' : undefined}
      className={`flex items-center gap-2.5 px-2.5 py-2 rounded-control ${active ? 'bg-white' : 'hover:bg-black/[.03]'}`}
      style={active ? { boxShadow: 'var(--ring)' } : undefined}>
      {icon ? <span className={active ? 'text-primary' : 'text-[#5c5c5c]'}>{icon}</span> : (
        <span className="relative w-[7px] h-[7px] shrink-0 ml-[4px] mr-[4px]">
          {pulse && <span className="absolute inset-0 rounded-full bg-primary animate-ping opacity-60" />}
          <span className={`absolute inset-0 rounded-full ${pulse ? 'bg-primary' : (dot || 'bg-[#1a7f4b]')}`} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className={`block text-sm font-medium leading-tight ${active ? 'text-fg' : 'text-[#262626]'}`}>{title}</span>
        <span className="block text-xs text-faint leading-tight mt-0.5 truncate">{sub}</span>
      </span>
      {count != null && <span className="text-xs text-faint tnum shrink-0">{count}</span>}
    </Link>
  );
}
