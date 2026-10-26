import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowLeftRight, Check, ChevronsUpDown, Globe, KeyRound, Settings as SettingsIcon, Target, Users, UserPlus, X } from 'lucide-react';
import { api, timeAgo } from '../../api.js';
import Avatar from '../Avatar.jsx';
import Badge from '../Badge.jsx';
import Button from '../Button.jsx';
import RichSelect from '../RichSelect.jsx';
import SettingsCard from '../settings/SettingsCard.jsx';
import UnderlineTabs from '../settings/UnderlineTabs.jsx';
import GoalModal from './GoalModal.jsx';
import GiveAccessModal from './GiveAccessModal.jsx';
import MonitoringTab from './MonitoringTab.jsx';
import TokensTab from './TokensTab.jsx';
import TransferProjectModal from './TransferProjectModal.jsx';
import { STATUS } from '../../lib/palette.js';
import { siteDomain, siteInitials } from '../../lib/nav.js';
import { ROLE_LABELS, SCOPED_PERMISSIONS, goalLine } from '../../lib/workspace.js';

const PROJECT_TABS = [
  { key: 'general', label: 'General', icon: SettingsIcon },
  { key: 'people', label: 'People', icon: Users },
  { key: 'tokens', label: 'API tokens', icon: KeyRound, manage: true },
  { key: 'monitoring', label: 'Monitoring', icon: Activity },
];
const options = ['admin', 'member'].map((value) => ({ value, label: SCOPED_PERMISSIONS[value].label, description: SCOPED_PERMISSIONS[value].description }));

// Account settings → Project: everything about ONE project in one place: its goal
// and details (and moving it to another workspace), who can open it, its API
// tokens and its health. `project.role` is the person's role on THIS project:
// 'owner' / 'admin' manage it, 'member' (read-only) only looks. Someone given just
// this project sees exactly the same page, with nothing about the workspace around it.
export default function ProjectSettings({ projects, project, email, tab, onTab, onPickProject, onChanged }) {
  const [overview, setOverview] = useState(null);
  const [goalOpen, setGoalOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const pickRef = useRef(null);
  const manage = project.role === 'admin' || project.role === 'owner';
  const tabs = PROJECT_TABS.filter((t) => manage || !t.manage);
  const active = tabs.some((t) => t.key === tab) ? tab : 'general';

  const refresh = () => api.project.overview(project.id).then(setOverview).catch(() => setOverview({ projects: [], needsAttention: 0, activity: [] }));
  useEffect(() => { setOverview(null); refresh(); }, [project.id]);
  useEffect(() => {
    if (!pickOpen) return;
    const onDown = (e) => { if (!pickRef.current?.contains(e.target)) setPickOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [pickOpen]);

  const p = overview?.projects?.[0];
  const health = !overview ? '–' : overview.needsAttention ? '1 issue' : 'All healthy';
  const goalState = !overview ? '–' : p?.goal ? 'Set' : 'None yet';

  return (
    <>
      <div className="tray mt-5">
        <div className="tray-card">
          <div className="flex items-center gap-3 px-5 py-4">
            <span className="w-11 h-11 rounded-[10px] bg-primary text-white text-[15px] font-medium grid place-items-center shrink-0">{siteInitials(project.name)}</span>
            <div className="min-w-0 flex-1">
              <div className="text-[17px] font-medium tracking-[-0.02em] text-fg truncate">{project.name}</div>
              <div className="mt-0.5 flex items-center gap-1.5 flex-wrap"><Badge tone="primary">{ROLE_LABELS[project.role]}</Badge>{project.shared && <Badge tone="grey">Shared with you</Badge>}</div>
            </div>
            {projects.length > 1 && (
              <div className="relative" ref={pickRef}>
                <Button variant="light" onClick={() => setPickOpen((o) => !o)} aria-haspopup="menu" aria-expanded={pickOpen}><ChevronsUpDown size={14} /><span className="hidden sm:inline">Switch project</span></Button>
                {pickOpen && (
                  <div role="menu" className="absolute right-0 top-full mt-1.5 z-30 w-64 max-h-[50vh] overflow-y-auto bg-white rounded-card p-1" style={{ boxShadow: '0 0 0 1px rgba(0,0,0,.06), 0 20px 40px -12px rgba(0,0,0,.18)' }}>
                    {projects.map((x) => (
                      <button key={x.id} type="button" role="menuitem" onClick={() => { setPickOpen(false); onPickProject(x.id); }} className="w-full flex items-center gap-2 h-9 px-2 rounded-control hover:bg-muted text-left">
                        <span className="w-5 h-5 bg-primary text-white text-[9px] font-medium grid place-items-center shrink-0" style={{ borderRadius: 6 }}>{siteInitials(x.name)}</span>
                        <span className="min-w-0 flex-1"><span className="block text-[13px] font-medium text-fg truncate leading-4">{x.name}</span>{x.workspaceName && <span className="block text-[11px] text-faint truncate">{x.workspaceName}</span>}</span>
                        {x.id === project.id && <Check size={14} className="text-faint shrink-0" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="grid grid-cols-3 border-t border-border">
            {[['Website', siteDomain({ website_domain: project.domain }) || '–'], ['Goal', goalState], ['Health', health]].map(([l, v]) => (
              <div key={l} className="text-left px-5 py-3 border-r border-border last:border-0 min-w-0"><div className="text-xs text-faint">{l}</div><div className="text-[15px] font-medium text-fg truncate">{v}</div></div>
            ))}
          </div>
        </div>
      </div>

      <UnderlineTabs tabs={tabs} value={active} onChange={onTab} />

      <div className="mt-5">
        {active === 'general' && (
          <div className="space-y-3">
            <SettingsCard icon={Target} title="Goal" description="What you want to grow with this project. Set it when you create a project, change it here any time."
              action={manage && <Button variant="light" onClick={() => setGoalOpen(true)}>{p?.goal ? 'Edit goal' : 'Set a goal'}</Button>}>
              <div className="px-5 py-4 flex items-center gap-3">
                <span className="w-8 h-8 rounded-[8px] bg-primary text-white text-[11px] font-medium grid place-items-center shrink-0">{siteInitials(project.name)}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-fg">{!overview ? ' ' : p?.goal ? goalLine(p.goal) : 'No goal yet'}</div>
                  <div className="text-xs text-faint mt-0.5">{p?.goal ? 'Tracked on your Overview' : 'Pick what matters most and by when'}</div>
                </div>
              </div>
            </SettingsCard>
            <SettingsCard icon={Globe} title="Details" description="What this project tracks.">
              <dl className="px-5 py-1">
                {[['Name', project.name], ['Website address', siteDomain({ website_domain: project.domain }) || 'Not set'], ...(project.workspaceName && !project.shared ? [['Workspace', project.workspaceName]] : [])].map(([l, v]) => (
                  <div key={l} className="grid grid-cols-1 sm:grid-cols-[160px_1fr] gap-x-3 py-2.5 border-b border-border last:border-0"><dt className="text-[13px] text-faint">{l}</dt><dd className="text-sm text-fg min-w-0 truncate">{v}</dd></div>
                ))}
              </dl>
            </SettingsCard>
            {project.canTransfer && (
              <SettingsCard icon={ArrowLeftRight} title="Transfer project" description="Move this project, with its goal, tokens and history, to another workspace you manage."
                action={<Button variant="light" onClick={() => setTransferOpen(true)}><ArrowLeftRight size={14} />Transfer project</Button>}>
                <div className="px-5 py-3 text-[13px] text-text">People who can open it now can keep access to this project only.</div>
              </SettingsCard>
            )}
          </div>
        )}
        {active === 'people' && <ProjectPeople project={project} email={email} manage={manage} />}
        {active === 'tokens' && manage && <TokensTab projects={[{ id: project.id, name: project.name }]} workspaceName="" tokensApi={{
          list: () => api.project.tokens.list(project.id), create: (b) => api.project.tokens.create(project.id, b), revoke: (id) => api.project.tokens.revoke(project.id, id),
        }} />}
        {active === 'monitoring' && <MonitoringTab overview={overview} email={email} />}
      </div>

      <GoalModal project={goalOpen ? { id: project.id, name: project.name, goal: p?.goal } : null} saveGoal={(g) => api.project.setGoal(project.id, g)}
        onClose={() => setGoalOpen(false)} onSaved={async () => { setGoalOpen(false); await refresh(); await onChanged?.(); }} />
      {project.canTransfer && <TransferProjectModal project={project} isOpen={transferOpen} onClose={() => setTransferOpen(false)} onDone={async (res) => { await onChanged?.(res); }} />}
    </>
  );
}

function ProjectPeople({ project, email, manage }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [giveOpen, setGiveOpen] = useState(false);
  const [saving, setSaving] = useState({});
  const load = () => api.project.members(project.id).then(setData).catch((e) => setError(e.message || 'Could not load the people with access.'));
  useEffect(() => { setData(null); load(); }, [project.id]);
  const act = async (id, fn, fail) => { setSaving((s) => ({ ...s, [id]: true })); try { await fn(); await load(); } catch (err) { setError(err.message || fail); } setSaving((s) => ({ ...s, [id]: false })); };

  return (
    <div>
      <SettingsCard icon={Users} title="People with access" description={`Everyone who can open ${project.name}, and what they can do.`}
        action={manage && <Button variant="light" onClick={() => setGiveOpen(true)}><UserPlus size={14} />Give access</Button>}>
        {error && <div className="mx-5 my-3 rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2">{error}</div>}
        {!data ? [0, 1].map((i) => <div key={i} className="px-5 py-3 border-b border-border last:border-0"><div className="h-5 bg-muted rounded-control animate-pulse" /></div>) : (
          <div>
            {data.members.map((m) => {
              const self = m.email === email;
              return (
                <div key={m.id} className="flex items-center gap-3 px-5 py-3 border-b border-border last:border-0">
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: m.status === 'disabled' ? STATUS.critical.color : STATUS.good.color }} />
                  <Avatar email={m.email} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium text-fg truncate">{m.email}{self && <span className="text-faint font-normal"> (you)</span>}</p>
                    <p className="text-xs text-faint">{m.last_login_at ? `Last active ${timeAgo(m.last_login_at)}` : 'Never logged in'}</p>
                  </div>
                  {manage && !self ? <div className="shrink-0 w-[130px]"><RichSelect block align="right" label={`Access for ${m.email}`} value={m.role} disabled={!!saving[m.id]}
                    onChange={(r) => r !== m.role && act(m.id, () => api.project.setRole(project.id, m.id, r), 'Could not change that person’s access.')} options={options} /></div>
                    : <Badge tone="grey" className="shrink-0">{ROLE_LABELS[m.role] || m.role}</Badge>}
                  {manage && !self ? <Button variant="ghost" size="sm" icon title="Remove access" aria-label={`Remove ${m.email}`} disabled={!!saving[m.id]}
                    onClick={() => confirm(`Remove ${m.email}’s access to ${project.name}?`) && act(m.id, () => api.project.remove(project.id, m.id), 'Could not remove that person.')}><X size={14} /></Button> : <span className="w-6 shrink-0" aria-hidden />}
                </div>
              );
            })}
            {data.invitations.map((inv) => (
              <div key={inv.id} className="flex items-center gap-3 px-5 py-3 border-b border-border last:border-0">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: STATUS.warning.color }} />
                <span className="w-7 h-7 rounded-full bg-muted text-faint grid place-items-center shrink-0"><UserPlus size={13} /></span>
                <div className="min-w-0 flex-1"><p className="text-[13px] font-medium text-fg truncate">{inv.email}</p><p className="text-xs text-faint">Invited {timeAgo(inv.created_at)} · waiting to accept</p></div>
                <Badge tone="amber" className="shrink-0">Invited</Badge><Badge tone="outline" className="shrink-0">{ROLE_LABELS[inv.role] || inv.role}</Badge><span className="w-6 shrink-0" aria-hidden />
              </div>
            ))}
          </div>
        )}
      </SettingsCard>
      <div className="tray mt-3"><div className="tray-card">
        <div className="px-5 py-3 border-b border-border text-[13px] font-medium text-fg">What each permission means</div>
        {['admin', 'member'].map((k) => (
          <div key={k} className="flex items-baseline gap-3 px-5 py-2.5 border-b border-border last:border-0">
            <span className="w-20 shrink-0 text-[13px] font-medium text-fg">{SCOPED_PERMISSIONS[k].label}</span>
            <span className="text-[13px] text-text">{k === 'admin' ? 'Can set the goal, create API tokens and give or remove access to this project.' : 'Can see everything in this project, but cannot change anything.'}</span>
          </div>
        ))}
      </div></div>
      {manage && <GiveAccessModal onlyProject={{ id: project.id, name: project.name }} isOpen={giveOpen} onClose={() => setGiveOpen(false)} onDone={load} />}
    </div>
  );
}
