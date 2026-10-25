import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Building2, Globe, KeyRound, Plus, Settings as SettingsIcon, Users } from 'lucide-react';
import { api } from '../api.js';
import Badge from '../components/Badge.jsx';
import Button from '../components/Button.jsx';
import AddProjectModal from '../components/AddProjectModal.jsx';
import McpTokensCard from '../components/McpTokensCard.jsx';
import TeamCard from '../components/TeamCard.jsx';
import ScopeCards from '../components/settings/ScopeCards.jsx';
import SettingsCard, { SettingsRows } from '../components/settings/SettingsCard.jsx';
import UnderlineTabs from '../components/settings/UnderlineTabs.jsx';
import { SETTINGS_TABS, settingsLocation, currentSiteOf, siteDomain, siteInitials } from '../lib/nav.js';

// Three settings levels: Account (the person) lives on its own page at
// /account; Workspace and Project live here, each with tabs, and the open
// level + tab are in the query string (?scope=…&tab=…).
//
// A workspace is real: it comes from GET /api/workspaces, scoped on the server
// to the workspaces the signed-in user belongs to (a platform admin sees all).
// The "current" workspace is the one that contains the active project.
const TAB_ICONS = { general: SettingsIcon, projects: Globe, team: Users, details: Globe, tokens: KeyRound };

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const WORKSPACE_ROLE_LABELS = { owner: 'Owner', admin: 'Admin', member: 'Member', platform: 'Platform admin' };
const CAN_ADD_PROJECT = new Set(['owner', 'admin', 'platform']);

function SiteTile({ site, size = 26, radius = 'rounded-[7px]', text = 'text-[11px]' }) {
  const box = { width: size, height: size };
  return site?.logo_data_url ? (
    <img src={site.logo_data_url} alt="" style={box} className={`${radius} object-contain shrink-0`} />
  ) : (
    <span style={box} className={`${radius} bg-primary text-white ${text} font-medium grid place-items-center shrink-0`}>
      {siteInitials(site?.name)}
    </span>
  );
}

const typeBadge = (site) => (
  <Badge tone="outline">{site?.property_type === 'product' ? 'Product' : 'Website'}</Badge>
);

export default function Settings({ sites = [], siteId, role, onSite }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { scope, tab } = settingsLocation(searchParams.toString());
  const go = (nextScope, nextTab) => setSearchParams(nextTab ? { scope: nextScope, tab: nextTab } : { scope: nextScope });

  const current = currentSiteOf(sites, siteId);

  // null = loading. Reloaded after a project is added so the lists stay true.
  const [workspaces, setWorkspaces] = useState(null);
  const [addFor, setAddFor] = useState(null);
  const loadWorkspaces = () => api.workspaces().then((r) => setWorkspaces(r.workspaces || [])).catch(() => setWorkspaces([]));
  useEffect(() => { loadWorkspaces(); }, [siteId]);

  const currentWorkspace = workspaces?.find((w) => w.projects.some((p) => p.id === current?.id)) || null;
  const workspaceName = currentWorkspace?.name || sites[0]?.name || 'Your workspace';
  const workspaceRole = currentWorkspace?.role;
  const roleLabel = workspaceRole ? <Badge tone="primary">{WORKSPACE_ROLE_LABELS[workspaceRole] || workspaceRole}</Badge> : null;

  const openProject = (id) => { if (id !== current?.id) onSite(id); go('project'); };

  const addProjectButton = (w) => CAN_ADD_PROJECT.has(w.role) && (
    <Button variant="light" onClick={() => setAddFor(w)}><Plus size={14} />Add project</Button>
  );

  return (
    <div className="max-w-[960px] mx-auto px-4 md:px-6 pt-6 pb-12 fade-up">
      <h1 className="text-[22px] leading-7 md:text-[26px] md:leading-8 font-medium tracking-[-0.03em] text-fg">Settings</h1>
      <p className="mt-1 text-sm text-text">Your workspaces and the project you are working in.</p>

      <ScopeCards current={scope} items={[
        { key: 'workspace', label: 'Workspace', description: 'Team and projects', icon: Building2, onSelect: () => go('workspace') },
        { key: 'project', label: 'Project', description: 'Details and API tokens', icon: Globe, onSelect: () => go('project') },
      ]} />

      <UnderlineTabs tabs={SETTINGS_TABS[scope].map((t) => ({ ...t, icon: TAB_ICONS[t.key] }))} value={tab} onChange={(t) => go(scope, t)} />

      <div className="space-y-3 mt-5">
        {scope === 'workspace' && tab === 'general' && (
          <>
            <SettingsCard icon={Building2} title="Current workspace" description="Where you are working right now"
              action={currentWorkspace && (
                <div className="flex items-center gap-2">
                  {CAN_ADD_PROJECT.has(currentWorkspace.role) && (
                    <Button variant="light" onClick={() => setAddFor(currentWorkspace)}><Plus size={14} /><span className="hidden sm:inline">Add project</span></Button>
                  )}
                  <Button variant="light" onClick={() => go('workspace', 'team')}><Users size={14} /><span className="hidden sm:inline">Manage team</span></Button>
                </div>
              )}>
              {workspaces === null ? (
                <div className="px-5 py-4"><div className="h-14 bg-muted rounded-control animate-pulse" /></div>
              ) : (
                <>
                  <div className="flex items-center gap-3 px-5 py-4">
                    <SiteTile site={currentWorkspace?.projects[0] || current} size={44} radius="rounded-[10px]" text="text-[15px]" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[17px] font-medium tracking-[-0.02em] text-fg truncate">{workspaceName}</div>
                      <div className="mt-0.5">{roleLabel}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 border-t border-border">
                    {[
                      ['Projects', currentWorkspace ? currentWorkspace.projects.length : '–', () => go('workspace', 'projects')],
                      ['Members', currentWorkspace ? (currentWorkspace.memberCount ?? 0) : '–', () => go('workspace', 'team')],
                      ['Current project', current?.name || '–', () => go('project')],
                    ].map(([label, value, onClick]) => (
                      <button key={label} type="button" onClick={onClick}
                        className="text-left px-5 py-3 border-r border-border last:border-0 hover:bg-muted/50 transition min-w-0">
                        <div className="text-xs text-faint">{label}</div>
                        <div className="text-[15px] font-medium text-fg truncate">{value}</div>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </SettingsCard>

            {workspaces && workspaces.length > 1 && (
              <SettingsCard icon={Building2} title="Switch workspace" description={`${workspaces.length} workspaces you can access`}>
                {workspaces.filter((w) => w.id !== currentWorkspace?.id).map((w) => (
                  <div key={w.id} className="flex items-center gap-3 px-5 py-3 border-b border-border last:border-0">
                    <SiteTile site={w.projects[0]} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-fg truncate">{w.name}</div>
                      <div className="text-xs text-faint">
                        {plural(w.projects.length, 'project', 'projects')} · {plural(w.memberCount ?? 0, 'member', 'members')}
                      </div>
                    </div>
                    {w.role !== 'platform' && <Badge tone="primary" className="hidden sm:inline-flex">{WORKSPACE_ROLE_LABELS[w.role] || w.role}</Badge>}
                    <Button variant="light" size="sm" disabled={!w.projects.length} onClick={() => w.projects[0] && onSite(w.projects[0].id)}>Switch</Button>
                  </div>
                ))}
              </SettingsCard>
            )}
          </>
        )}

        {scope === 'workspace' && tab === 'projects' && (
          workspaces === null ? (
            <SettingsCard icon={Globe} title="Projects" description="Sites in each of your workspaces">
              <div className="px-5 py-3"><div className="h-5 bg-muted rounded-control animate-pulse" /></div>
            </SettingsCard>
          ) : workspaces.length === 0 ? (
            <SettingsCard icon={Globe} title="Projects" description="Sites in each of your workspaces">
              <div className="px-5 py-8 text-center text-[13px] text-faint">No projects in this workspace yet.</div>
            </SettingsCard>
          ) : workspaces.map((w) => (
            <SettingsCard key={w.id} icon={Globe} title={w.name}
              description={plural(w.projects.length, 'project', 'projects')}
              action={addProjectButton(w)}>
              {w.projects.length === 0 ? (
                <div className="px-5 py-8 text-center text-[13px] text-faint">No projects in this workspace yet.</div>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th className="hidden sm:table-cell">Domain</th>
                      <th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {w.projects.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <span className="font-medium">{p.name}</span>
                          {p.id === current?.id && <Badge tone="grey" className="ml-2">Current</Badge>}
                        </td>
                        <td className="hidden sm:table-cell text-text">{p.domain}</td>
                        <td className="num">
                          <Button variant="ghost" size="sm" onClick={() => openProject(p.id)}>
                            Project settings →
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </SettingsCard>
          ))
        )}

        {scope === 'workspace' && tab === 'team' && (
          currentWorkspace
            ? <TeamCard workspace={currentWorkspace} />
            : <SettingsCard icon={Users} title="Members" description="Everyone with access to this workspace">
              <div className="px-5 py-3"><div className="h-5 bg-muted rounded-control animate-pulse" /></div>
            </SettingsCard>
        )}

        {scope === 'project' && tab === 'details' && (
          <SettingsCard icon={Globe} title="Project" description="What this project tracks · switch project from the site picker in the sidebar">
            <SettingsRows rows={[
              ['Name', current?.name],
              ['Domain', siteDomain(current)],
              ['Type', typeBadge(current)],
              ['Workspace', workspaceName],
            ]} />
          </SettingsCard>
        )}

        {scope === 'project' && tab === 'tokens' && <McpTokensCard projectDomain={siteDomain(current)} />}
      </div>

      {addFor && (
        <AddProjectModal workspace={addFor} isOpen onClose={() => setAddFor(null)}
          onCreated={async (project) => { setAddFor(null); await loadWorkspaces(); onSite(project.id); }} />
      )}
    </div>
  );
}
