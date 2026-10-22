import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Building2, Globe, KeyRound, Settings as SettingsIcon, Users } from 'lucide-react';
import { api } from '../api.js';
import Badge from '../components/Badge.jsx';
import Button from '../components/Button.jsx';
import RoleBadge from '../components/RoleBadge.jsx';
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
// "Workspace" is a label over today's data: the workspace name is the first
// site's name (sites[0]?.name — the same rule the old Settings page used for
// its workspace badge). There are no other workspaces to list.
const TAB_ICONS = { general: SettingsIcon, projects: Globe, team: Users, details: Globe, tokens: KeyRound };

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

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
  const workspaceName = sites[0]?.name || 'Your workspace';

  // Member count for the workspace summary: null while loading or on error.
  const [members, setMembers] = useState(null);
  useEffect(() => {
    api.team.list().then((list) => setMembers(Array.isArray(list) ? list.length : null)).catch(() => setMembers(null));
  }, []);

  const roleBadge = <RoleBadge role={role} tone="brand" />;

  return (
    <div className="max-w-[960px] mx-auto px-4 md:px-6 pt-6 pb-12 fade-up">
      <h1 className="text-[22px] leading-7 md:text-[26px] md:leading-8 font-medium tracking-[-0.03em] text-fg">Settings</h1>
      <p className="mt-1 text-sm text-text">Your workspaces and the project you are working in.</p>

      <ScopeCards current={scope} items={[
        { key: 'workspace', label: 'Workspace', description: `${workspaceName} · team and projects`, icon: Building2, onSelect: () => go('workspace') },
        { key: 'project', label: 'Project', description: `${siteDomain(current) || current?.name || '—'} · details and API`, icon: Globe, onSelect: () => go('project') },
      ]} />

      <UnderlineTabs tabs={SETTINGS_TABS[scope].map((t) => ({ ...t, icon: TAB_ICONS[t.key] }))} value={tab} onChange={(t) => go(scope, t)} />

      <div className="space-y-5 mt-5">
        {scope === 'workspace' && tab === 'general' && (
          <>
            <SettingsCard icon={Building2} title="Your workspaces" description="Every workspace you belong to">
              <div className="flex items-center gap-3 px-5 py-3">
                <SiteTile site={sites[0]} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-fg truncate">{workspaceName}</div>
                  <div className="text-xs text-faint">
                    {plural(sites.length, 'project', 'projects')}{members != null && ` · ${plural(members, 'member', 'members')}`}
                  </div>
                </div>
                <Badge tone="grey">Current</Badge>
                {roleBadge}
              </div>
            </SettingsCard>
            <SettingsCard icon={SettingsIcon} title="Workspace" description="Details of the current workspace">
              <SettingsRows rows={[
                ['Name', workspaceName],
                ['Your role', roleBadge],
                ['Projects', String(sites.length)],
                ['Members', members != null && String(members)],
              ]} />
            </SettingsCard>
          </>
        )}

        {scope === 'workspace' && tab === 'projects' && (
          <SettingsCard icon={Globe} title="Projects" description="Sites in each of your workspaces">
            {sites.length === 0 ? (
              <div className="px-5 py-8 text-center text-[13px] text-faint">No projects in this workspace yet.</div>
            ) : (
              <>
                <div className="flex items-center gap-2 px-5 py-2.5 bg-[#fcfcfb] border-b border-border text-[13px] font-medium text-fg">
                  <SiteTile site={sites[0]} size={16} radius="rounded-[5px]" text="text-[8px]" />
                  {workspaceName}
                  <span className="text-faint font-normal">· {plural(sites.length, 'project', 'projects')}</span>
                </div>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th className="hidden sm:table-cell">Domain</th>
                      <th>Type</th>
                      <th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {sites.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <span className="font-medium">{s.name}</span>
                          {s.id === current?.id && <Badge tone="grey" className="ml-2">Current</Badge>}
                        </td>
                        <td className="hidden sm:table-cell text-text">{siteDomain(s)}</td>
                        <td>{typeBadge(s)}</td>
                        <td className="num">
                          <Button variant="ghost" size="sm" onClick={() => { if (s.id !== current?.id) onSite(s.id); go('project'); }}>
                            Project settings →
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </SettingsCard>
        )}

        {scope === 'workspace' && tab === 'team' && <TeamCard role={role} workspaceName={workspaceName}
          projects={sites.map((s) => ({ id: s.id, name: s.name, domain: siteDomain(s), logo: s.logo_data_url }))} currentProjectId={current?.id} />}

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
    </div>
  );
}
