import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, ArrowLeftRight, Check, ChevronsUpDown, Globe, KeyRound, MapPin, Search, Settings as SettingsIcon, Target, Users, UserPlus, X } from 'lucide-react';
import { api, timeAgo } from '../../api.js';
import Avatar from '../Avatar.jsx';
import Badge from '../Badge.jsx';
import Button from '../Button.jsx';
import RichSelect from '../RichSelect.jsx';
import SettingsCard from '../settings/SettingsCard.jsx';
import UnderlineTabs from '../settings/UnderlineTabs.jsx';
import GoalModal from './GoalModal.jsx';
import BusinessProfileModal from './BusinessProfileModal.jsx';
import { GBP_LABELS } from './BusinessProfileFields.jsx';
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
  const [gbpOpen, setGbpOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const [pickQuery, setPickQuery] = useState('');
  const [menuPos, setMenuPos] = useState(null);
  const pickRef = useRef(null);   // the button
  const menuRef = useRef(null);   // the menu itself, which lives outside the card (see the portal below)
  const manage = project.role === 'admin' || project.role === 'owner';
  const tabs = PROJECT_TABS.filter((t) => manage || !t.manage);
  const active = tabs.some((t) => t.key === tab) ? tab : 'general';

  const refresh = () => api.project.overview(project.id).then(setOverview).catch(() => setOverview({ projects: [], needsAttention: 0, activity: [] }));
  useEffect(() => { setOverview(null); refresh(); }, [project.id]);
  useEffect(() => {
    if (!pickOpen) return;
    const onDown = (e) => { if (!pickRef.current?.contains(e.target) && !menuRef.current?.contains(e.target)) setPickOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setPickOpen(false); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [pickOpen]);

  // The menu sits in <body>, under the button: inside the card it was clipped by the card's edge and showed
  // two projects of nine. Placed from the button's position, clamped to stay on screen.
  useLayoutEffect(() => {
    if (!pickOpen) { setMenuPos(null); setPickQuery(''); return; }
    const place = () => {
      const r = pickRef.current?.getBoundingClientRect();
      if (!r) return;
      const w = Math.min(340, window.innerWidth - 24);
      setMenuPos({ top: r.bottom + 6, left: Math.max(12, Math.min(r.right - w, window.innerWidth - w - 12)), width: w });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [pickOpen]);

  // Every project you can open, grouped by the workspace it is in. The workspace of the project you are looking
  // at comes first, then the rest alphabetically, then projects shared with you one by one.
  const groups = useMemo(() => {
    const q = pickQuery.trim().toLowerCase();
    const map = new Map();
    for (const x of projects) {
      if (q && !(x.name.toLowerCase().includes(q) || (x.domain || '').toLowerCase().includes(q) || (x.workspaceName || '').toLowerCase().includes(q))) continue;
      const key = x.shared ? '__shared__' : (x.workspaceName || 'Projects');
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(x);
    }
    const current = project.shared ? '__shared__' : (project.workspaceName || 'Projects');
    return [...map.entries()].sort(([a], [b]) => (a === current ? -1 : b === current ? 1 : a === '__shared__' ? 1 : b === '__shared__' ? -1 : a.localeCompare(b)))
      .map(([key, items]) => ({ key, label: key === '__shared__' ? 'Shared with you' : key, items: items.sort((a, b) => a.name.localeCompare(b.name)) }));
  }, [projects, pickQuery, project.id]);

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
            {/* Both header actions side by side. Transfer is here, not in a card at the bottom of the page, so it is
                reachable the moment a project is open; it appears whenever the person may transfer this project. */}
            <div className="flex items-center gap-2 shrink-0">
              {project.canTransfer && (
                <Button variant="light" onClick={() => setTransferOpen(true)} title="Move this project, with its goal, tokens and history, to another workspace you manage">
                  <ArrowLeftRight size={14} /><span className="hidden sm:inline">Transfer</span><span className="sm:hidden sr-only">Transfer project</span>
                </Button>
              )}
              {projects.length > 1 && (
                <div className="relative" ref={pickRef}>
                  <Button variant="light" onClick={() => setPickOpen((o) => !o)} aria-haspopup="menu" aria-expanded={pickOpen}><ChevronsUpDown size={14} /><span className="hidden sm:inline">Switch project</span></Button>
                </div>
              )}
            </div>
            {pickOpen && menuPos && createPortal(
              <div ref={menuRef} role="menu" aria-label="Switch project" className="fixed z-50 max-h-[60vh] overflow-y-auto bg-white rounded-card p-1"
                style={{ top: menuPos.top, left: menuPos.left, width: menuPos.width, boxShadow: '0 0 0 1px rgba(0,0,0,.06), 0 20px 40px -12px rgba(0,0,0,.18)' }}>
                {projects.length > 8 && (
                  <div className="relative p-1">
                    <Search size={13} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
                    <input type="text" autoFocus value={pickQuery} onChange={(e) => setPickQuery(e.target.value)} placeholder="Search projects" aria-label="Search projects"
                      className="h-8 w-full pl-8 pr-3 rounded-control bg-white text-[13px] text-fg outline-none" style={{ boxShadow: '0 0 0 1px var(--input)' }} />
                  </div>
                )}
                {groups.length === 0 && <div className="px-3 py-4 text-center text-[13px] text-faint">No project matches.</div>}
                {groups.map((g) => (
                  <div key={g.key}>
                    <div className="px-2 pt-2 pb-1 text-[11px] font-medium uppercase tracking-[.08em] text-faint truncate">{g.label}</div>
                    {g.items.map((x) => (
                      <button key={x.id} type="button" role="menuitem" onClick={() => { setPickOpen(false); onPickProject(x.id); }}
                        className="w-full flex items-center gap-2.5 min-h-[40px] px-2 py-1 rounded-control hover:bg-muted text-left">
                        <span className="w-6 h-6 bg-primary text-white text-[10px] font-medium grid place-items-center shrink-0" style={{ borderRadius: 7 }}>{siteInitials(x.name)}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] font-medium text-fg truncate leading-4">{x.name}</span>
                          <span className="block text-[11px] text-faint truncate">{siteDomain({ website_domain: x.domain }) || 'No website set'}</span>
                        </span>
                        {x.id === project.id && <Check size={14} className="text-faint shrink-0" />}
                      </button>
                    ))}
                  </div>
                ))}
              </div>,
              document.body
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
            <SettingsCard icon={MapPin} title="Business Profile" description="Your listing on Google Maps and local search. Optional."
              action={manage && <Button variant="light" onClick={() => setGbpOpen(true)}>{p?.businessProfile?.status ? 'Change' : 'Add'}</Button>}>
              <div className="px-5 py-4 min-w-0">
                <div className="text-[13px] font-medium text-fg">{!overview ? ' ' : GBP_LABELS[p?.businessProfile?.status] || 'Not set up yet'}</div>
                <div className="text-xs text-faint mt-0.5 break-words">
                  {p?.businessProfile?.status === 'linked' && p.businessProfile.url
                    ? <a href={p.businessProfile.url} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-primary">{p.businessProfile.url.replace(/^https?:\/\//, '')}</a>
                    : p?.businessProfile?.status === 'none' ? 'Create one so you show up in Maps and local searches.'
                    : p?.businessProfile?.status === 'not_applicable' ? 'Marked as not a local business.'
                    : 'Add it so Google Maps and local results can show your business.'}
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
          </div>
        )}
        {active === 'people' && <ProjectPeople project={project} email={email} manage={manage} />}
        {active === 'tokens' && manage && <TokensTab projects={[{ id: project.id, name: project.name }]} workspaceName="" tokensApi={{
          list: () => api.project.tokens.list(project.id), create: (b) => api.project.tokens.create(project.id, b), revoke: (id) => api.project.tokens.revoke(project.id, id),
        }} />}
        {active === 'monitoring' && <MonitoringTab overview={overview} email={email} />}
      </div>

      <BusinessProfileModal project={gbpOpen ? { id: project.id, name: project.name, domain: project.domain, businessProfile: p?.businessProfile } : null}
        onClose={() => setGbpOpen(false)} onSaved={async () => { setGbpOpen(false); await refresh(); await onChanged?.(); }} />
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
