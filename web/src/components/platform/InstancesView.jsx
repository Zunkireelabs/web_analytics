import { useEffect, useState } from 'react';
import { ArrowLeft, Bot, Brain, BarChart3, Clock, GitBranch, Info, LayoutDashboard, ListChecks, Search, ShieldCheck, Sliders, Activity } from 'lucide-react';
import { api } from '../../api.js';
import Badge from '../Badge.jsx';
import Button from '../Button.jsx';
import SettingsCard, { SettingsRows } from '../settings/SettingsCard.jsx';
import { ProjectAvatar, shortDate } from './ListParts.jsx';
import { siteInitials } from '../../lib/nav.js';
import MasterAgentCard from './MasterAgentCard.jsx';
import AgentsTable from './AgentsTable.jsx';
import { Switch, useAutonomy } from './AutonomySwitch.jsx';

// Account settings -> Platform -> Agent instances: one row per project (its Growth Agent), and one project's counts and statuses.
// Two things can be switched here by a platform admin, each confirmed and recorded by the server: the Master Agent's mode and a
// project's Auto-fixes. The server never sends page, query, draft or memory text (server/lib/instance-view.js).

const STATE_TONE = { running: 'green', waiting_to_connect: 'amber', setting_up: 'grey', paused: 'red', removed: 'red' };
const CONNECTIONS = [
  { key: 'searchConsole', label: 'Search Console', icon: Search },
  { key: 'analytics', label: 'Analytics', icon: BarChart3 },
  { key: 'github', label: 'GitHub', icon: GitBranch },
  { key: 'analyst', label: 'Analyst', icon: Brain },
];

const isToday = (d) => new Date(d).toDateString() === new Date().toDateString();
const clock = (d) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const whenText = (d) => (d ? (isToday(d) ? `Today ${clock(d)}` : shortDate(d)) : 'Not run yet');
const duration = (ms) => {
  if (ms < 60000) return `${Math.round(ms / 1000)} s`;
  const m = Math.floor(ms / 60000); const sec = Math.round((ms % 60000) / 1000);
  return sec ? `${m} min ${sec} s` : `${m} min`;
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const AGENT_NAMES = (id) => String(id || '').replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

function Tiles({ connections }) {
  return (
    <span className="inline-flex items-center gap-1" role="group" aria-label="Connections">
      {CONNECTIONS.map(({ key, label, icon: Icon }) => {
        const on = Boolean(connections?.[key]);
        return (
          <span key={key} role="img" aria-label={`${label}: ${on ? 'connected' : 'not connected'}`} title={`${label}: ${on ? 'connected' : 'not connected'}`}
            className="size-6 rounded-[7px] grid place-items-center"
            style={on ? { background: 'var(--green-tint)', color: 'var(--green)' } : { color: 'var(--faint, #9a9a9a)', border: '1px dashed #cfcfcf' }}>
            <Icon size={13} strokeWidth={on ? 2.2 : 1.8} />
          </span>
        );
      })}
    </span>
  );
}

const StateBadge = ({ r }) => <Badge tone={STATE_TONE[r.state] || 'grey'} dot>{r.stateLabel}</Badge>;

function growthText(r) {
  if (!r.growth) return ['Not available', ''];
  const sub = r.surge?.active ? `Surge on until ${shortDate(r.surge.expiresAt)}` : r.growth.daysLeftInStage ? `${plural(r.growth.daysLeftInStage, 'day', 'days')} left` : '';
  return [`Day ${r.growth.day} · ${r.growth.label}`, sub];
}
function autonomyText(r) {
  if (r.autonomy.enabled) return [`On · up to ${r.autonomy.dailyCapacity} a day`, r.surge?.active ? 'First-30-days surge' : ''];
  return ['Auto-fixes off', r.state === 'running' ? 'Switched on per project' : 'Starts after it is connected'];
}
function runText(r) {
  if (!r.lastRun.at) return ['Not run yet', r.needs.length ? `Needs ${r.needs.join(', ')}` : r.state === 'running' ? 'No run recorded' : ''];
  return [whenText(r.lastRun.at), `${plural(r.lastRun.agentsLast24h, 'agent', 'agents')} · ${r.lastRun.failedLast24h} failed (24 h)`];
}

const GRID = 'lg:grid-cols-[minmax(0,1.3fr)_140px_minmax(0,1.3fr)_minmax(150px,1.1fr)_minmax(0,1.2fr)_124px_112px]';
const Cell = ({ label, children }) => (
  <span className="col-span-2 lg:col-span-1 grid grid-cols-[104px_minmax(0,1fr)] lg:block gap-x-2 min-w-0">
    <span className="lg:hidden text-[11px] uppercase tracking-wide text-faint pt-0.5">{label}</span>
    <span className="min-w-0">{children}</span>
  </span>
);
const Two = ({ lines }) => (<><b className="block text-[13px] font-medium text-fg">{lines[0]}</b>{lines[1] && <span className="block text-xs text-faint">{lines[1]}</span>}</>);

function AutoCell({ r, onToggle }) {
  const a = r.autonomy || {};
  if (a.canEnable === undefined) return <Two lines={autonomyText(r)} />; // an older payload without the switch's facts
  const sub = a.enabled ? 'Opens fixes as pull requests' : a.canEnable ? 'Safe to switch on' : (a.blockedReason || 'Not ready yet');
  return (
    <>
      <Switch on={Boolean(a.enabled)} disabled={!a.enabled && !a.canEnable} label={`Auto-fixes ${a.enabled ? 'on' : 'off'}`} onClick={() => onToggle(r)} />
      <span className="block text-xs text-faint mt-1">{sub}</span>
    </>
  );
}

function Row({ r, onOpen, onToggleAuto, onDashboard }) {
  return (
    <li className={`grid grid-cols-[minmax(0,1fr)_auto] ${GRID} items-center gap-x-3 gap-y-2 px-4 py-3`}>
      <span className="flex items-center gap-3 min-w-0">
        <ProjectAvatar initials={siteInitials(r.name)} />
        <span className="min-w-0">
          <span className="block text-[13.5px] font-medium text-fg truncate">{r.name}</span>
          <span className="block text-xs text-faint truncate">{r.domain || 'No website set'}</span>
        </span>
      </span>
      <span className="lg:order-last flex lg:flex-col items-stretch justify-end gap-1.5">
        <Button variant="light" size="sm" onClick={() => onOpen(r.id)} aria-label={`Open the agents running for ${r.name}`}><Bot size={13} />Agents</Button>
        <Button variant="light" size="sm" onClick={() => onDashboard(r)} aria-label={`Open ${r.name}'s Overview dashboard`}><LayoutDashboard size={13} />Dashboard</Button>
      </span>
      <Cell label="State"><StateBadge r={r} /></Cell>
      <Cell label="Growth stage"><Two lines={growthText(r)} /></Cell>
      <Cell label="Autonomy"><AutoCell r={r} onToggle={onToggleAuto} /></Cell>
      <Cell label="Last run"><Two lines={runText(r)} /></Cell>
      <Cell label="Connections"><Tiles connections={r.connections} /></Cell>
    </li>
  );
}

function Notice() {
  return (
    <div className="flex items-start gap-2.5 rounded-[12px] bg-[#fafaf9] px-3.5 py-2.5 text-[13px] text-text" style={{ boxShadow: '0 0 0 1px var(--border)' }}>
      <Info size={15} className="text-faint mt-0.5 shrink-0" />
      <span>The Master Agent and each project&rsquo;s Auto-fixes can be switched here; every change is recorded with your name. Access and other limits are under <b className="text-fg">Controls</b> on All workspaces. Project memory is never shown here, only how much there is.</span>
    </div>
  );
}

function List({ data, master, onOpen, onMasterChanged, onToggleAuto, onDashboard }) {
  const s = data.summary;
  const chips = [
    [s.running, 'running'], [s.waiting, 'waiting to be connected'], [s.paused, 'paused'],
    [`${s.ranLast24h} of ${s.runningTotal}`, 'ran in the last 24 hours'], [s.needAttention, 'need attention'],
  ];
  return (
    <div className="space-y-3">
      <Notice />
      <MasterAgentCard m={master} onChanged={onMasterChanged} />
      <div className="flex flex-wrap gap-2">
        {chips.map(([n, label]) => (
          <span key={label} className="inline-flex items-center gap-1.5 rounded-[10px] bg-white px-3 py-1.5 text-[13px] text-text" style={{ boxShadow: '0 0 0 1px var(--input)' }}>
            <b className="font-semibold text-fg tnum">{n}</b>{label}
          </span>
        ))}
      </div>
      {data.instances.length === 0
        ? <p className="px-1 py-6 text-[13px] text-faint">No projects yet.</p>
        : (
          <div className="rounded-card bg-white overflow-hidden" style={{ boxShadow: '0 0 0 1px var(--input)' }}>
            <div className={`hidden lg:grid ${GRID} gap-x-3 px-4 py-2.5 text-xs text-faint bg-[#fafaf9] border-b border-border`}>
              <span>Project</span><span>State</span><span>Growth stage</span><span>Autonomy</span><span>Last daily run</span><span>Connections</span><span />
            </div>
            <ul className="list-none m-0 p-0 divide-y divide-border">{data.instances.map((r) => <Row key={r.id} r={r} onOpen={onOpen} onToggleAuto={onToggleAuto} onDashboard={onDashboard} />)}</ul>
          </div>
        )}
    </div>
  );
}

const Yes = ({ children = 'Connected' }) => <Badge tone="green" dot>{children}</Badge>;
const No = ({ children = 'Not connected' }) => <Badge tone="grey" dot>{children}</Badge>;
const Sub = ({ children }) => <small className="block text-xs text-faint">{children}</small>;

function Detail({ d, onBack, actions, onToggleAuto }) {
  const [growth] = growthText(d);
  const ready = d.readiness;
  const readyDone = ready ? ready.items.filter((i) => i.ok === true).length : null;
  const readyTotal = ready ? ready.items.filter((i) => i.ok !== null).length : null;
  const perm = d.trainingPermission;
  return (
    <div className="space-y-3.5">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-[13px] text-text hover:text-fg"><ArrowLeft size={14} />All instances</button>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-3 min-w-[220px] flex-1">
          <span className="w-10 h-10 rounded-[11px] bg-primary text-white text-[13px] font-medium grid place-items-center shrink-0" aria-hidden="true">{siteInitials(d.name)}</span>
          <span className="min-w-0">
            <h2 className="text-[20px] leading-7 font-semibold text-fg truncate">{d.name}</h2>
            <span className="block text-xs text-faint truncate">{[d.domain, `project ${d.id}`, d.workspaceName && `workspace "${d.workspaceName}"`].filter(Boolean).join(' · ')}</span>
          </span>
        </span>
        {d.industry?.label && <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-[12.5px] text-text"><b className="font-medium text-fg">Industry</b>{d.industry.label}</span>}
        <StateBadge r={d} />
        <Button variant="light" onClick={() => actions.openSupport({ id: d.id, name: d.name })} disabled={actions.opening === d.id} title="Opens this client's dashboard as support. Logged."><LayoutDashboard size={14} />Open dashboard</Button>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        {[
          ['Agents last run', d.agents?.length ? `${d.lastRun.agentsRan ?? d.agents.filter((x) => x.lastStatus === 'ok').length} ran${(d.lastRun.agentsFailed ?? d.agents.filter((x) => x.lastStatus === 'failed').length) ? ` · ${d.lastRun.agentsFailed ?? d.agents.filter((x) => x.lastStatus === 'failed').length} failed` : ''}` : 'None yet'],
          ['Last daily run', d.lastRun.at ? whenText(d.lastRun.at) : 'Not run yet'],
          ['Auto-fixes', d.autonomy?.enabled ? 'On' : 'Off'],
          ['Setup', ready ? `${readyDone} of ${readyTotal} in place` : 'Could not be checked'],
        ].map(([label, value]) => (
          <div key={label} className="rounded-[12px] bg-white px-3.5 py-2.5" style={{ boxShadow: '0 0 0 1px var(--input)' }}>
            <div className="text-xs text-faint">{label}</div>
            <div className="mt-0.5 text-[15px] font-semibold text-fg tnum">{value}</div>
          </div>
        ))}
      </div>
      <div className="grid gap-3.5 lg:grid-cols-2 items-start">
        {d.autonomy && d.autonomy.canEnable !== undefined && (
          <SettingsCard bare icon={ShieldCheck} title="Autonomous fixes"
            description="Opens safe fixes as pull requests after each daily run. Anything riskier waits for approval. A person always merges."
            action={<Switch on={Boolean(d.autonomy.enabled)} disabled={!d.autonomy.enabled && !d.autonomy.canEnable} label={d.autonomy.enabled ? 'On' : 'Off'} onClick={() => onToggleAuto(d)} />}>
            {!d.autonomy.enabled && !d.autonomy.canEnable
              ? <div className="mx-4 mb-4 rounded-[10px] px-3 py-2.5 text-[13px] leading-[19px]" style={{ background: '#fdf3e1', boxShadow: 'inset 0 0 0 1px #f1dcae', color: '#7a5b00' }}>{d.autonomy.blockedReason || 'Not ready yet.'}</div>
              : (
                <SettingsRows rows={[
                  ['Changed', d.autonomy.changedAt ? <>{shortDate(d.autonomy.changedAt)}{d.autonomy.changedBy ? `, ${d.autonomy.changedBy}` : ''}<Sub>{d.autonomy.enabled ? 'Off → On' : 'On → Off'}</Sub></> : <>Never switched on<Sub>Starts after you switch it on, from the next daily run</Sub></>],
                  ['Last 7 days', <>{d.autonomy.last7Days?.opened ?? 0} {(d.autonomy.last7Days?.opened ?? 0) === 1 ? 'fix' : 'fixes'} opened as pull requests<Sub>{d.autonomy.last7Days?.merged != null && d.autonomy.last7Days?.waiting != null ? `${d.autonomy.last7Days.merged} merged by the client · ${d.autonomy.last7Days.waiting} waiting for review` : 'Fixes still appear in the client’s Action Center for approval'}</Sub></>],
                ]} />
              )}
          </SettingsCard>
        )}
        <SettingsCard bare icon={Clock} title="Last daily run" description={d.lastRun.at ? `${whenText(d.lastRun.at)}${d.lastRun.durationMs ? ` · ${duration(d.lastRun.durationMs)} end to end` : ''}` : 'Not run yet. It runs once the project is connected.'}>
          <SettingsRows rows={[
            ['This run', d.lastRun.at ? (d.lastRun.agentsRan != null ? `${plural(d.lastRun.agentsRan, 'agent', 'agents')} ran · ${d.lastRun.agentsSkipped || 0} skipped · ${d.lastRun.agentsFailed || 0} failed` : `${plural(d.lastRun.agentsLast24h, 'agent', 'agents')} in the last 24 h · ${d.lastRun.failedLast24h} failed`) : '—'],
            ['Last 7 days', `Ran ${d.last7Days.daysRan} of ${d.last7Days.daysTotal} days`],
            d.last7Days.slowestAgent && ['Slowest agent', `${AGENT_NAMES(d.last7Days.slowestAgent.id)} · ${duration(d.last7Days.slowestAgent.ms)}`],
            ['Industry', d.industry?.label ? <>{d.industry.label}<Sub>{[d.industry.source && `From ${d.industry.source}`, d.industry.confidence && `confidence ${d.industry.confidence}`].filter(Boolean).join(' · ')}</Sub></> : 'Not set'],
            ['Growth stage', growth],
          ]} />
        </SettingsCard>
      </div>
      {Array.isArray(d.agents) && (
        <SettingsCard bare icon={Bot} title="Agents running here" description="Every agent that runs for this client, what it does, and when it last ran. Read only.">
          <AgentsTable agents={d.agents} waitingText="No agent has run for this project yet. They start with the first daily run after Search Console, Analytics and GitHub are connected." />
        </SettingsCard>
      )}
      <details className="group rounded-card bg-white" style={{ boxShadow: '0 0 0 1px var(--input)' }}>
        <summary className="flex items-center gap-2 cursor-pointer list-none px-4 py-3 text-[13.5px] font-medium text-fg">
          Setup, memory and configuration<span className="text-xs font-normal text-faint">{ready ? `${readyDone} of ${readyTotal} setup checks in place` : ''}</span>
          <span className="ml-auto text-faint text-xs group-open:hidden">Show</span><span className="ml-auto text-faint text-xs hidden group-open:inline">Hide</span>
        </summary>
        <div className="grid gap-3.5 lg:grid-cols-2 items-start p-3.5 pt-0">
          <div className="space-y-3.5 min-w-0">
          <SettingsCard bare icon={ListChecks} title="Ready to run">
            <SettingsRows rows={[
              ['Readiness checks', ready
                ? <>{readyDone} of {readyTotal} in place<div className="h-1.5 rounded-full bg-muted overflow-hidden mt-1.5"><div className="h-full rounded-full" style={{ width: `${readyTotal ? Math.round((readyDone / readyTotal) * 100) : 0}%`, background: 'var(--green)' }} /></div></>
                : 'Could not be checked'],
              ready && ready.items.some((i) => i.ok === false) && ['Still missing', ready.items.filter((i) => i.ok === false).map((i) => i.label).join(', ')],
              ...CONNECTIONS.map(({ key, label }) => [label, d.connections[key] ? <Yes>{key === 'analyst' ? 'Provisioned' : 'Connected'}</Yes> : <No>{key === 'analyst' ? 'Not provisioned' : 'Not connected'}</No>]),
            ]} />
          </SettingsCard>
          <SettingsCard bare icon={ShieldCheck} title="Identity and isolation">
            <SettingsRows rows={[
              ['Project ID', String(d.id)],
              ['Analyst client', <><Badge tone={d.analystLink === 'linked' ? 'green' : 'amber'} dot>{d.analystLink === 'linked' ? 'Linked' : 'Not created yet'}</Badge><Sub>{d.analystLink === 'linked' ? 'Analyst client id matches the project id' : 'Created when the project is connected'}</Sub></>],
              ['Data for shared training', <><Badge tone="grey">{perm.value === 'not_configured' ? 'Not configured' : perm.value}</Badge><Sub>Treated as none: nothing leaves this project</Sub></>],
              ['Counts-only industry learning', 'Included'],
            ]} />
          </SettingsCard>
          </div>
          <div className="space-y-3.5 min-w-0">
          <SettingsCard bare icon={Brain} title="Memory and learning">
            <SettingsRows rows={[
              ['Project memory', d.memory ? <>{plural(d.memory.versions, 'version', 'versions')}<Sub>Last updated {whenText(d.memory.lastUpdatedAt).toLowerCase()}. Content is not shown here, by design.</Sub></> : 'Not available yet'],
              ['Measured outcomes', d.outcomes ? <>{plural(d.outcomes.measured, 'fix', 'fixes')} measured<Sub>{d.outcomes.improved} improved · {d.outcomes.declined} declined</Sub></> : 'Not available yet'],
            ]} />
          </SettingsCard>
          <SettingsCard bare icon={Activity} title="Lifecycle and growth">
            <SettingsRows rows={[
              ['First 30 days', d.surgeDetail.active
                ? <>Surge on, day {d.surgeDetail.day} of 30<Sub>Ends {shortDate(d.surgeDetail.expiresAt)}</Sub></>
                : <>{d.surgeDetail.reason === 'expired' ? 'Finished' : 'Not applicable'}<Sub>{d.surgeDetail.reason === 'expired' ? 'Back to the normal daily limit' : 'Started before this feature, so it is off'}</Sub></>],
              ['Daily capacity', <>{String(d.capacity.dailyCapacity)}<Sub>{d.capacity.usedToday == null ? 'Used today: not available yet' : `Used today: ${d.capacity.usedToday} of ${d.capacity.dailyCapacity}`} · hard ceiling {d.capacity.hardCeiling}</Sub></>],
            ]} />
          </SettingsCard>
          <SettingsCard bare icon={Sliders} title="Configuration">
            <SettingsRows rows={[
              ['Rank tracking', d.configuration.rankTracking ? 'On' : 'Off'],
              ['Competitor growth', d.configuration.competitorGrowth ? 'On' : 'Off'],
              ['Target scope', d.configuration.targetScope ? `${d.configuration.targetScope[0].toUpperCase()}${d.configuration.targetScope.slice(1)}${d.configuration.targetPlaces ? ` · ${plural(d.configuration.targetPlaces, 'place', 'places')}` : ''}` : 'Not set'],
            ]} />
          </SettingsCard>
          </div>
        </div>
      </details>
      <p className="text-xs text-faint">Everything here is a count or a status: no pages, queries, drafts or memory text are shown. Opening the dashboard uses the existing support action and is logged.</p>
    </div>
  );
}

export default function InstancesView({ actions }) {
  const [list, setList] = useState(null);
  const [master, setMaster] = useState(null);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);
  // Auto-fixes: one flow for the list rows and the detail page; the server's answer updates both.
  const auto = useAutonomy((id, autonomy) => {
    setList((l) => (l ? { ...l, instances: l.instances.map((r) => (r.id === id ? { ...r, autonomy: { ...r.autonomy, ...autonomy } } : r)) } : l));
    setDetail((d) => (d && d.id === id ? { ...d, autonomy: { ...d.autonomy, ...autonomy } } : d));
  });

  useEffect(() => {
    api.platform.instances().then(setList).catch((e) => setError(e.message || 'Could not load the instances.'));
    api.platform.masterAgent().then(setMaster).catch(() => {}); // an extra, never blocks the list
  }, []);
  useEffect(() => {
    if (openId == null) { setDetail(null); return undefined; }
    let live = true;
    setDetail(null);
    api.platform.instance(openId).then((d) => { if (live) setDetail(d); }).catch((e) => { if (live) setError(e.message || 'Could not load that project.'); });
    return () => { live = false; };
  }, [openId]);

  if (openId != null && detail) {
    return (<>{auto.error && !auto.busy && <div className="text-[13px] mb-3" style={{ color: '#b42318' }} role="alert">{auto.error}</div>}<Detail d={detail} onBack={() => { setOpenId(null); setError(null); }} actions={actions} onToggleAuto={auto.toggle} />{auto.dialog}</>);
  }
  return (
    <SettingsCard icon={Bot} title="Agent instances" description="One row per project: the growth agent that runs for it, what stage it is in and whether it ran today.">
      <div className="px-4 sm:px-5 py-4">
        {error && <div className="text-[13px] mb-3" style={{ color: '#b42318' }} role="alert">{error}</div>}
        {auto.error && !auto.busy && <div className="text-[13px] mb-3" style={{ color: '#b42318' }} role="alert">{auto.error}</div>}
        {!error && list === null && <div className="h-5 bg-muted rounded-control animate-pulse" />}
        {list && openId == null && <List data={list} master={master} onOpen={setOpenId} onMasterChanged={setMaster} onToggleAuto={auto.toggle} onDashboard={(r) => actions.openSupport({ id: r.id, name: r.name })} />}
        {auto.dialog}
        {openId != null && !detail && !error && <div className="h-5 bg-muted rounded-control animate-pulse" />}
        {openId != null && error && <button type="button" onClick={() => { setOpenId(null); setError(null); }} className="text-[13px] text-primary hover:underline">Back to the list</button>}
      </div>
    </SettingsCard>
  );
}
