import { useEffect, useState } from 'react';
import { api, timeAgo } from '../../api.js';
import PageToolbar from '../../components/PageToolbar.jsx';
import PageIntro from '../../components/layout/PageIntro.jsx';
import { Tray, TrayCard } from '../../components/layout/Tray.jsx';
import SegmentedTabs from '../../components/SegmentedTabs.jsx';
import Badge from '../../components/Badge.jsx';
import Button from '../../components/Button.jsx';
import Field from '../../components/Field.jsx';
import Select from '../../components/Select.jsx';
import { UserPlus, Ban, KeyRound } from 'lucide-react';

// Mirrors login.js's PLATFORM_ROLE_RANK/TENANT_ROLE_RANK — this is the only
// path permitted to grant a platform tier (PLATFORM-ADMIN-DESIGN.md §E), so
// unlike Settings.jsx's Team tab (tenant-tier only), every role is offered
// here.
const ALL_ROLES = ['platform_admin', 'tenant_admin', 'tenant_member'];
const ROLE_LABELS = {
  platform_admin: 'Platform Admin',
  tenant_admin: 'Tenant Admin',
  tenant_member: 'Tenant Member',
};

// Kept in sync by hand with mcp-server/permissions.js's PERMISSION_LEVELS,
// same as McpTokensCard.jsx's own TIERS list.
const TIER_LABELS = { read_only: 'Read Only', ai_actions: 'AI Actions', automation: 'Automation', admin: 'Admin' };

const TABS = [
  { value: 'users', label: 'Users' },
  { value: 'tokens', label: 'MCP tokens' },
];

const inputRing = { boxShadow: '0 0 0 1px var(--input)' };

const ErrorBanner = ({ children }) => (
  <div className="rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2 mb-3">{children}</div>
);

const Skeleton = () => (
  <div className="px-5 py-4">
    <div className="h-5 bg-muted rounded-control animate-pulse" />
  </div>
);

function UsersTab() {
  const [users, setUsers] = useState(null); // null = loading
  const [sites, setSites] = useState([]);
  const [error, setError] = useState(null);

  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('tenant_admin');
  const [inviteSiteId, setInviteSiteId] = useState('');
  const [inviteState, setInviteState] = useState('idle'); // idle | sending | error
  const [inviteError, setInviteError] = useState(null);

  const [roleSaving, setRoleSaving] = useState({}); // {[userId]: true}
  const [disabling, setDisabling] = useState({}); // {[userId]: true}

  const load = () => api.adminUsers.list().then(setUsers).catch((e) => setError(e.message || 'Could not load users.'));

  useEffect(() => {
    load();
    api.clients.list().then(setSites).catch(() => {});
  }, []);

  const submitInvite = async (e) => {
    e.preventDefault();
    setInviteState('sending');
    setInviteError(null);
    try {
      await api.adminUsers.invite({ email: inviteEmail.trim(), role: inviteRole, siteId: Number(inviteSiteId) });
      setInviteEmail('');
      setInviteRole('tenant_admin');
      setInviteSiteId('');
      setShowInvite(false);
      setInviteState('idle');
      await load();
    } catch (err) {
      setInviteError(err.message || 'Could not send invitation.');
      setInviteState('error');
    }
  };

  const changeRole = async (user, role) => {
    if (role === user.role) return;
    setRoleSaving((s) => ({ ...s, [user.id]: true }));
    try {
      await api.adminUsers.updateRole(user.id, role);
      await load();
    } catch (err) {
      setError(err.message || 'Could not change role.');
    } finally {
      setRoleSaving((s) => ({ ...s, [user.id]: false }));
    }
  };

  const disable = async (user) => {
    if (!confirm(`Disable ${user.email}? They will be logged out and lose access immediately.`)) return;
    setDisabling((s) => ({ ...s, [user.id]: true }));
    try {
      await api.adminUsers.disable(user.id);
      await load();
    } catch (err) {
      setError(err.message || 'Could not disable user.');
    } finally {
      setDisabling((s) => ({ ...s, [user.id]: false }));
    }
  };

  const roleSelect = (u) => (
    <select value={u.role} disabled={!!roleSaving[u.id]} onChange={(e) => changeRole(u, e.target.value)}
      aria-label={`Role for ${u.email}`}
      className="h-8 w-full max-w-[170px] rounded-control bg-white text-[13px] text-fg px-2 outline-none disabled:opacity-60" style={inputRing}>
      {ALL_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
    </select>
  );

  return (
    <>
      <PageToolbar>
        <Button variant="primary" className="md:ml-auto" onClick={() => setShowInvite((s) => !s)}>
          {showInvite ? 'Cancel' : (<><UserPlus size={14} />Invite user</>)}
        </Button>
      </PageToolbar>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {showInvite && (
        <Tray className="mb-3">
          <TrayCard title="Invite a user" subtitle="Sends an email with a link to set a password. Never creates a login until accepted.">
            <form onSubmit={submitInvite} className="border-t border-border px-4 sm:px-5 py-4 space-y-4 max-w-md">
              <Field label="Email" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="name@example.com" required />
              <Select label="Role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} required>
                {ALL_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </Select>
              <Select label="Tenant" value={inviteSiteId} onChange={(e) => setInviteSiteId(e.target.value)} required>
                <option value="" disabled>Select a site…</option>
                {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
              {inviteState === 'error' && inviteError && (
                <div className="rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2">{inviteError}</div>
              )}
              <Button type="submit" variant="primary" disabled={inviteState === 'sending'}>
                {inviteState === 'sending' ? 'Sending…' : 'Send invitation'}
              </Button>
            </form>
          </TrayCard>
        </Tray>
      )}

      <Tray>
        <TrayCard title="Users" subtitle={users ? `${users.length} in the directory` : undefined}>
          {users === null ? (
            <div className="border-t border-border"><Skeleton /></div>
          ) : users.length === 0 ? (
            <p className="border-t border-border px-5 py-6 text-center text-[13px] text-faint">No users found.</p>
          ) : (
            <div className="overflow-x-auto border-t border-border">
              <table className="tbl table-fixed">
                <thead>
                  <tr>
                    <th className="lg:w-[38%] xl:w-[30%]">User</th>
                    <th className="hidden lg:table-cell lg:w-[24%] xl:w-[16%]">Tenant</th>
                    <th className="hidden xl:table-cell xl:w-[14%]">Last login</th>
                    <th className="hidden xl:table-cell xl:w-[12%]">Created</th>
                    <th className="hidden lg:table-cell lg:w-[26%] xl:w-[18%]">Role</th>
                    <th className="w-12" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium [overflow-wrap:anywhere]">{u.email}</span>
                          {u.status === 'disabled' && <Badge tone="red" className="shrink-0">Disabled</Badge>}
                        </div>
                        <div className="text-xs text-faint truncate lg:hidden">{u.site_name}</div>
                        <div className="lg:hidden mt-1.5">{roleSelect(u)}</div>
                      </td>
                      <td className="hidden lg:table-cell text-text truncate">{u.site_name}</td>
                      <td className="hidden xl:table-cell text-text">{u.last_login_at ? timeAgo(u.last_login_at) : 'Never logged in'}</td>
                      <td className="hidden xl:table-cell text-text">{timeAgo(u.created_at)}</td>
                      <td className="hidden lg:table-cell">{roleSelect(u)}</td>
                      <td className="num">
                        {u.status !== 'disabled' && (
                          <Button variant="ghost" size="sm" icon onClick={() => disable(u)} disabled={!!disabling[u.id]}
                            title="Disable user" aria-label={`Disable ${u.email}`}>
                            <Ban size={14} />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TrayCard>
      </Tray>
    </>
  );
}

function TokensTab() {
  const [tokens, setTokens] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [revoking, setRevoking] = useState({}); // {[id]: true}

  const load = () => api.mcpAdmin.list().then(setTokens).catch((e) => setError(e.message || 'Could not load tokens.'));

  useEffect(() => { load(); }, []);

  const revoke = async (token) => {
    if (!confirm(`Revoke this token for ${token.site_name}? Any client using it will immediately lose access.`)) return;
    setRevoking((s) => ({ ...s, [token.id]: true }));
    try {
      await api.mcpAdmin.revoke(token.id);
      await load();
    } catch (err) {
      setError(err.message || 'Could not revoke token.');
    } finally {
      setRevoking((s) => ({ ...s, [token.id]: false }));
    }
  };

  return (
    <>
      {error && <ErrorBanner>{error}</ErrorBanner>}

      <Tray>
        <TrayCard title="MCP tokens" subtitle={tokens ? `${tokens.length} issued across all tenants` : undefined}>
          {tokens === null ? (
            <div className="border-t border-border"><Skeleton /></div>
          ) : tokens.length === 0 ? (
            <p className="border-t border-border px-5 py-6 text-center text-[13px] text-faint">No tokens issued yet, across any tenant.</p>
          ) : (
            <div className="overflow-x-auto border-t border-border">
              <table className="tbl table-fixed">
                <thead>
                  <tr>
                    <th className="lg:w-[56%] xl:w-[40%]">Token</th>
                    <th className="hidden lg:table-cell lg:w-[30%] xl:w-[18%]">Tenant</th>
                    <th className="hidden xl:table-cell xl:w-[14%]">Last used</th>
                    <th className="hidden xl:table-cell xl:w-[12%]">Created</th>
                    <th className="w-12" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {tokens.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <div className="flex items-center gap-2 flex-wrap">
                          <KeyRound size={13} className="text-faint shrink-0" aria-hidden />
                          <span className="font-medium [overflow-wrap:anywhere]">{t.label || 'Unnamed token'}</span>
                          <span className="font-mono text-xs text-faint">{t.token_prefix}••••••</span>
                          <Badge tone="grey">{TIER_LABELS[t.permission_level] || t.permission_level}</Badge>
                          {t.revoked_at && <Badge tone="red">Revoked</Badge>}
                        </div>
                        <div className="text-xs text-faint truncate lg:hidden mt-0.5">{t.site_name}</div>
                      </td>
                      <td className="hidden lg:table-cell text-text truncate">{t.site_name}</td>
                      <td className="hidden xl:table-cell text-text">{t.last_used_at ? timeAgo(t.last_used_at) : 'Never used'}</td>
                      <td className="hidden xl:table-cell text-text">{timeAgo(t.created_at)}</td>
                      <td className="num">
                        {!t.revoked_at && (
                          <Button variant="ghost" size="sm" icon onClick={() => revoke(t)} disabled={!!revoking[t.id]}
                            title="Revoke token" aria-label={`Revoke token ${t.label || t.token_prefix}`}>
                            <Ban size={14} />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TrayCard>
      </Tray>
    </>
  );
}

export default function UsersAndTokens() {
  const [tab, setTab] = useState('users');

  return (
    <div className="max-w-[1360px] mx-auto px-4 md:px-6 pt-6 pb-12 fade-up">
      <PageToolbar>
        <SegmentedTabs options={TABS} value={tab} onChange={setTab} />
      </PageToolbar>

      <PageIntro
        title="Users & MCP tokens"
        subtitle={tab === 'users'
          ? "Platform-wide directory — every tenant's users, plus platform staff."
          : 'Cross-tenant view of every self-serve API token — metadata only, never a raw token value.'}
      />
      {tab === 'users' ? <UsersTab /> : <TokensTab />}
    </div>
  );
}
