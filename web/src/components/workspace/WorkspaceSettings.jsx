import { useEffect, useRef, useState } from 'react';
import { Activity, Building2, Check, ChevronsUpDown, Settings as SettingsIcon, Users } from 'lucide-react';
import { api } from '../../api.js';
import Badge from '../Badge.jsx';
import Button from '../Button.jsx';
import { Tray } from '../layout/Tray.jsx';
import UnderlineTabs from '../settings/UnderlineTabs.jsx';
import PeopleTab from './PeopleTab.jsx';
import SettingsTab from './SettingsTab.jsx';
import { ActivityCard } from './MonitoringTab.jsx';
import { ROLE_LABELS, canManageWorkspace, plural } from '../../lib/workspace.js';

const TABS = [
  { key: 'general', label: 'General', icon: SettingsIcon, manage: true },
  { key: 'people', label: 'People', icon: Users },
  { key: 'activity', label: 'Activity', icon: Activity },
];

// Account settings → Workspace: the workspace itself. Its name and ownership (and
// handing it over), who has access, and what changed recently. Projects live on the
// Workspace page; each project's goal, tokens and health are under Account settings →
// Project.
export default function WorkspaceSettings({ workspaces, workspace, email, tab, onTab, onPickWorkspace, reload }) {
  const [overview, setOverview] = useState(null);
  const [pickOpen, setPickOpen] = useState(false);
  const pickRef = useRef(null);
  const role = workspace.role;
  const manage = canManageWorkspace(role);
  const tabs = TABS.filter((t) => manage || !t.manage);
  const active = tabs.some((t) => t.key === tab) ? tab : tabs[0].key;

  const refresh = () => api.workspace.overview(workspace.id).then(setOverview).catch(() => setOverview({ projects: [], needsAttention: 0, activity: [] }));
  useEffect(() => { setOverview(null); refresh(); }, [workspace.id]);
  useEffect(() => {
    if (!pickOpen) return;
    const onDown = (e) => { if (!pickRef.current?.contains(e.target)) setPickOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [pickOpen]);

  return (
    <>
      <div className="tray mt-5">
        <div className="tray-card">
          <div className="flex items-center gap-3 px-5 py-4">
            <span className="w-11 h-11 rounded-[10px] bg-fg text-white grid place-items-center shrink-0"><Building2 size={20} /></span>
            <div className="min-w-0 flex-1">
              <div className="text-[17px] font-medium tracking-[-0.02em] text-fg truncate">{workspace.name}</div>
              <div className="mt-0.5"><Badge tone="primary">{ROLE_LABELS[role] || role}</Badge></div>
            </div>
            {workspaces.length > 1 && (
              <div className="relative" ref={pickRef}>
                <Button variant="light" onClick={() => setPickOpen((o) => !o)} aria-haspopup="menu" aria-expanded={pickOpen}><ChevronsUpDown size={14} /><span className="hidden sm:inline">Switch workspace</span></Button>
                {pickOpen && (
                  <div role="menu" className="absolute right-0 top-full mt-1.5 z-30 w-64 max-h-[50vh] overflow-y-auto bg-white rounded-card p-1" style={{ boxShadow: '0 0 0 1px rgba(0,0,0,.06), 0 20px 40px -12px rgba(0,0,0,.18)' }}>
                    {workspaces.map((w) => (
                      <button key={w.id} type="button" role="menuitem" onClick={() => { setPickOpen(false); onPickWorkspace(w.id); }} className="w-full flex items-center gap-2 h-9 px-2 rounded-control hover:bg-muted text-left">
                        <span className="w-6 h-6 rounded-[7px] bg-fg text-white grid place-items-center shrink-0"><Building2 size={13} /></span>
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{w.name}</span>
                        {w.id === workspace.id && <Check size={14} className="text-faint shrink-0" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="grid grid-cols-3 border-t border-border">
            {[['Projects', workspace.projects.length], ['People', workspace.memberCount ?? 0], ['Plan', 'Agency Scale']].map(([l, v]) => (
              <div key={l} className="text-left px-5 py-3 border-r border-border last:border-0 min-w-0"><div className="text-xs text-faint">{l}</div><div className="text-[15px] font-medium text-fg truncate">{v}</div></div>
            ))}
          </div>
        </div>
      </div>

      <UnderlineTabs tabs={tabs} value={active} onChange={onTab} />

      <div className="mt-5">
        {active === 'general' && manage && <SettingsTab workspace={workspace} role={role} onChanged={async () => { await reload?.(); await refresh(); }} />}
        {active === 'people' && <PeopleTab workspace={workspace} role={role} onChanged={reload} />}
        {active === 'activity' && (overview ? <Tray><ActivityCard activity={overview.activity} email={email} /></Tray> : <Tray><div className="tray-card px-5 py-8"><div className="h-5 bg-muted rounded-control animate-pulse" /></div></Tray>)}
      </div>
    </>
  );
}
