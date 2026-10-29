import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, Building2, ChevronLeft, Globe, LogOut, ShieldCheck, User } from 'lucide-react';
import { api } from '../api.js';
import Button from '../components/Button.jsx';
import AccountCard from '../components/AccountCard.jsx';
import SecurityCard from '../components/SecurityCard.jsx';
import ScopeCards from '../components/settings/ScopeCards.jsx';
import SettingsCard from '../components/settings/SettingsCard.jsx';
import PlanBilling from '../components/settings/PlanBilling.jsx';
import WorkspaceSettings from '../components/workspace/WorkspaceSettings.jsx';
import ProjectSettings from '../components/workspace/ProjectSettings.jsx';
import PlatformSettings from '../components/workspace/PlatformSettings.jsx';
import { STATUS } from '../lib/palette.js';

// PLACEHOLDER until billing exists: the current plan comes from this one constant,
// nothing is read from the server. `audience` + `plan` pick the card in lib/plans.js.
const ACCOUNT_PLAN = { audience: 'agencies', plan: 'Scale', label: 'Agency Scale', status: 'Active' };

// Whether the plans under "Manage billing" were left open; remembered per browser.
const BILLING_KEY = 'sr.account.billingOpen';
const readBillingOpen = () => { try { return localStorage.getItem(BILLING_KEY) === '1'; } catch { return false; } };
const writeBillingOpen = (v) => { try { localStorage.setItem(BILLING_KEY, v ? '1' : '0'); } catch { /* private mode: the panel just starts closed next time */ } };

const DangerIcon = (props) => <AlertCircle {...props} style={{ color: '#b42318' }} />;
const workspaceRoleOf = (role) => (role === 'platform' ? 'owner' : role);

// Standalone account settings (no sidebar / top bar), in three scopes:
//   Account    you: profile, sign-in, plan
//   Workspace  the workspace: name and hand-over, people, activity
//   Project    one project: goal, details and transfer, people, API tokens, health
//   Platform   (SuperRank team only) every workspace on the platform
// The projects themselves are on the Workspace page (sidebar). The scope, tab and
// the chosen workspace / project live in the query string (?scope=…&tab=…&ws=…&proj=…).
export default function Account({ email, role, sites, siteId, onLogout, onSwitchProject }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const [workspaces, setWorkspaces] = useState(null); // null = loading
  const [shared, setShared] = useState([]); // projects given to this person one by one
  const [billingOpen, setBillingOpen] = useState(() => params.get('tab') === 'billing' || readBillingOpen());

  const load = () => api.workspaces().then((r) => { setWorkspaces(r.workspaces || []); setShared(r.shared || []); }).catch(() => setWorkspaces([]));
  useEffect(() => { load(); }, [siteId]);

  const loading = workspaces === null;
  const hasWorkspaces = (workspaces?.length || 0) > 0;
  const allProjects = [
    ...(workspaces || []).flatMap((w) => w.projects.map((p) => ({
      id: p.id, name: p.name, domain: p.domain, workspaceId: w.id, workspaceName: w.name,
      role: workspaceRoleOf(w.role), canTransfer: workspaceRoleOf(w.role) === 'owner',
    }))),
    ...shared.map((p) => ({ id: p.id, name: p.name, domain: p.domain, role: p.role, shared: true })),
  ];

  const isPlatform = role === 'platform_admin';
  const wanted = params.get('scope');
  const pending = loading && (wanted === 'workspace' || wanted === 'project'); // keep the right scope while the lists load
  const scope = pending ? wanted : wanted === 'workspace' && hasWorkspaces ? 'workspace' : wanted === 'project' && allProjects.length ? 'project' : wanted === 'platform' && isPlatform ? 'platform' : 'account';
  const tab = params.get('tab');
  const workspace = workspaces && (workspaces.find((w) => w.id === Number(params.get('ws')))
    || workspaces.find((w) => w.projects.some((p) => p.id === siteId)) || workspaces[0] || null);
  const project = allProjects.find((p) => p.id === Number(params.get('proj'))) || allProjects.find((p) => p.id === siteId) || allProjects[0] || null;

  const go = (patch) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    Object.entries(patch).forEach(([k, v]) => (v == null ? next.delete(k) : next.set(k, v)));
    return next;
  }, { replace: true });

  const toggleBilling = () => { const next = !billingOpen; setBillingOpen(next); writeBillingOpen(next); go({ tab: next ? 'billing' : null }); };

  const items = [
    { key: 'account', label: 'Account', description: 'Profile, sign-in and plan', icon: User, onSelect: () => go({ scope: 'account', tab: null }) },
    ...(hasWorkspaces || pending ? [{ key: 'workspace', label: 'Workspace', description: 'General, people and activity', icon: Building2, onSelect: () => go({ scope: 'workspace', tab: null }) }] : []),
    ...(allProjects.length || pending ? [{ key: 'project', label: 'Project', description: 'Goal, tokens, people and health', icon: Globe, onSelect: () => go({ scope: 'project', tab: null }) }] : []),
    ...(isPlatform ? [{ key: 'platform', label: 'Platform', description: 'Every workspace on SuperRank', icon: ShieldCheck, onSelect: () => go({ scope: 'platform', tab: null }) }] : []),
  ];

  return (
    <div className="min-h-screen bg-canvas text-sm">
      <div className={`${scope === 'account' && !billingOpen ? 'max-w-[768px]' : 'max-w-[960px]'} mx-auto px-4 md:px-6 pt-8 pb-12`}>
        {/* A direct visit has no history to go back to. */}
        <button type="button" className="inline-flex items-center gap-1.5 text-sm text-fg hover:text-text"
          onClick={() => (location.key !== 'default' ? navigate(-1) : navigate('/'))}>
          <ChevronLeft size={14} /> Back
        </button>

        <div className="mt-7 flex items-center gap-2 text-sm text-text"><User size={15} /> Account</div>
        <h1 className="mt-2 text-[22px] leading-7 md:text-[26px] md:leading-8 font-medium tracking-[-0.03em] text-fg">Account settings</h1>
        <p className="mt-1 text-sm text-text">Your profile, your workspace and each project: people, API tokens, goals and health.</p>

        <ScopeCards current={scope} items={items} />

        {pending && <div className="tray mt-5"><div className="tray-card px-5 py-8"><div className="h-5 bg-muted rounded-control animate-pulse" /></div></div>}

        {scope === 'workspace' && workspace && (
          <WorkspaceSettings workspaces={workspaces} workspace={workspace} email={email} tab={tab} onTab={(t) => go({ tab: t })}
            onPickWorkspace={(id) => go({ ws: id, tab: null })} reload={load} />
        )}

        {scope === 'project' && project && (
          <ProjectSettings projects={allProjects} project={project} email={email} tab={tab} onTab={(t) => go({ tab: t })}
            onPickProject={(id) => go({ proj: id, tab: null })} onChanged={load} />
        )}

        {scope === 'platform' && <PlatformSettings onSwitchProject={onSwitchProject} />}

        {scope === 'account' && (
          <div className="space-y-3 mt-5">
            <AccountCard email={email} role={role} />
            <SecurityCard />
            <PlanBilling current={ACCOUNT_PLAN} email={email} open={billingOpen} onToggle={toggleBilling} />

            <SettingsCard icon={LogOut} title="Sign out" description="End your session on this device">
              <div className="px-5 py-3.5 flex flex-wrap items-center justify-between gap-3">
                <p className="text-[13px] text-faint">You will need to sign in again to see your dashboard.</p>
                <Button variant="light" className="text-[#b42318]" onClick={onLogout}>Sign out</Button>
              </div>
            </SettingsCard>

            <SettingsCard icon={DangerIcon} style={{ boxShadow: `0 0 0 1px ${STATUS.critical.ring}` }}
              title={<span className="text-[#b42318]">Danger zone</span>}
              description="Permanently delete your account and all associated data.">
              <div className="px-5 py-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-[#b42318]">Delete account</div>
                  <p className="text-[13px] text-text mt-0.5">Permanently delete your account and all associated data. This action cannot be undone.</p>
                </div>
                <button type="button" disabled aria-disabled title="Account deletion isn't available yet. Contact support to close your account."
                  className="btn" style={{ background: '#d92d20', color: '#fff' }}>Delete account</button>
              </div>
            </SettingsCard>
          </div>
        )}

      </div>
    </div>
  );
}
