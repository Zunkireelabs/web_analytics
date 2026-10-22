import { useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle, Building2, ChevronLeft, ChevronRight, CreditCard, Globe, KeyRound, LogOut, User, Users } from 'lucide-react';
import Button from '../components/Button.jsx';
import Badge from '../components/Badge.jsx';
import AccountCard from '../components/AccountCard.jsx';
import SecurityCard from '../components/SecurityCard.jsx';
import ScopeCards from '../components/settings/ScopeCards.jsx';
import SettingsCard from '../components/settings/SettingsCard.jsx';
import { currentSiteOf, siteDomain } from '../lib/nav.js';
import { STATUS } from '../lib/palette.js';

// PLACEHOLDER until billing exists: the plan name and status come from this one
// constant, nothing is read from the server.
const ACCOUNT_PLAN = { name: 'Agency Scale', status: 'Active' };

const DangerIcon = (props) => <AlertCircle {...props} style={{ color: '#b42318' }} />;

// Standalone account page (no sidebar / top bar): the person, shared across
// every workspace and project. Workspace + project settings live in /settings.
export default function Account({ email, role, sites, siteId, onLogout }) {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <div className="min-h-screen bg-canvas text-sm">
      <div className="max-w-[768px] mx-auto px-4 md:px-6 pt-8 pb-12">
        {/* A direct visit has no history to go back to. */}
        <button type="button" className="inline-flex items-center gap-1.5 text-sm text-fg hover:text-text"
          onClick={() => (location.key !== 'default' ? navigate(-1) : navigate('/'))}>
          <ChevronLeft size={14} /> Back
        </button>

        <div className="mt-7 flex items-center gap-2 text-sm text-text"><User size={15} /> Account</div>
        <h1 className="mt-2 text-[22px] leading-7 md:text-[26px] md:leading-8 font-medium tracking-[-0.03em] text-fg">Account settings</h1>
        <p className="mt-1 text-sm text-text">Your profile and sign-in, shared across every workspace and project.</p>

        <ScopeCards current="account" items={[
          { key: 'account', label: 'Account', description: 'Profile and sign-in', icon: User, onSelect: () => {} },
          { key: 'workspace', label: 'Workspace', description: `${sites?.[0]?.name || 'Your workspace'} · team and projects`, icon: Building2,
            onSelect: () => navigate('/settings?scope=workspace') },
          { key: 'project', label: 'Project', description: `${siteDomain(currentSiteOf(sites, siteId)) || 'Current project'} · details and API`, icon: Globe,
            onSelect: () => navigate('/settings?scope=project') },
        ]} />

        <div className="space-y-5 mt-5">
          <AccountCard email={email} role={role} />
          <SecurityCard />
          <SettingsCard icon={CreditCard} title="Plan & billing" description="Your subscription applies to your whole account — every workspace and project.">
            <div className="px-5 py-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-[13px] text-faint">Current plan</div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[20px] font-medium tracking-[-0.02em] text-fg">{ACCOUNT_PLAN.name}</span>
                  <Badge tone="grey">{ACCOUNT_PLAN.status}</Badge>
                </div>
              </div>
              <Button variant="light" disabled aria-disabled title="Billing management is coming soon.">Manage billing <ChevronRight size={14} /></Button>
            </div>
          </SettingsCard>

          <div className="grid gap-5 sm:grid-cols-2">
            <SettingsCard className="h-full" icon={Users} title="Team & workspaces" description="Invites and roles live on each workspace, not on your account.">
              <div className="px-5 py-4">
                <Button variant="light" onClick={() => navigate('/settings?scope=workspace&tab=team')}>Open workspace settings <ChevronRight size={14} /></Button>
                <p className="text-xs text-faint mt-2.5">Settings → Workspace → Team.</p>
              </div>
            </SettingsCard>
            <SettingsCard className="h-full" icon={KeyRound} title="API keys & MCP" description="API tokens belong to each project.">
              <div className="px-5 py-4">
                <Button variant="light" onClick={() => navigate('/settings?scope=project&tab=tokens')}>Open project settings <ChevronRight size={14} /></Button>
                <p className="text-xs text-faint mt-2.5">Settings → Project → API tokens.</p>
              </div>
            </SettingsCard>
          </div>

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
      </div>
    </div>
  );
}
