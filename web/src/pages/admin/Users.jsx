import { useEffect, useState } from 'react';
import { api, timeAgo } from '../../api.js';
import PageHeader from '../../components/PageHeader.jsx';
import { UserPlus, Mail, Ban } from 'lucide-react';

const inputCls = 'w-full text-base sm:text-xs border border-slate-200/80 rounded-xl px-3.5 py-2.5 bg-slate-50/50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#6C63FF]/10 focus:border-[#6C63FF] transition duration-150 font-medium text-slate-800 placeholder:text-slate-400';
const labelCls = 'block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5';

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

export default function AdminUsers() {
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

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      <PageHeader
        title="Users"
        icon="👥"
        subtitle="Platform-wide directory — every tenant's users, plus platform staff."
        right={
          <button type="button" onClick={() => setShowInvite((s) => !s)}
            className="text-[10px] font-black uppercase tracking-wider px-4.5 py-2.5 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] shadow-md shadow-indigo-500/10 hover:shadow-indigo-500/20 flex items-center gap-1.5"
            style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>
            {showInvite ? 'Cancel' : (<><UserPlus size={12} strokeWidth={2.5} /><span>Invite User</span></>)}
          </button>
        }
      />

      {error && (
        <div className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2">{error}</div>
      )}

      {showInvite && (
        <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-6 space-y-4 animate-fade-in">
          <div className="border-b border-slate-100 pb-3">
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-400">Invite a user</h3>
            <p className="text-[10px] text-slate-450 font-semibold mt-0.5">Sends an email with a link to set a password. Never creates a login until accepted.</p>
          </div>
          <form onSubmit={submitInvite} className="space-y-4 max-w-md">
            <label className="block">
              <span className={labelCls}>Email</span>
              <div className="relative">
                <Mail size={13} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <input type="email" className={`${inputCls} pl-9`} value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="name@example.com" required />
              </div>
            </label>
            <label className="block">
              <span className={labelCls}>Role</span>
              <select className={inputCls} value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} required>
                {ALL_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls}>Tenant</span>
              <select className={inputCls} value={inviteSiteId} onChange={(e) => setInviteSiteId(e.target.value)} required>
                <option value="" disabled>Select a site…</option>
                {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            {inviteState === 'error' && inviteError && (
              <div className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2">{inviteError}</div>
            )}
            <button type="submit" disabled={inviteState === 'sending'}
              className="text-[10px] font-black uppercase tracking-wider px-5 py-3 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] disabled:opacity-60 shadow-md shadow-indigo-500/10 hover:shadow-indigo-500/20"
              style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>
              {inviteState === 'sending' ? 'Sending…' : 'Send Invitation'}
            </button>
          </form>
        </div>
      )}

      <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-6">
        {users === null ? (
          <div className="p-8 text-center text-xs text-slate-400 animate-pulse">Loading directory…</div>
        ) : users.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-400 italic">No users found.</div>
        ) : (
          <div className="divide-y divide-slate-100/70">
            {users.map((u) => (
              <div key={u.id} className="py-3.5 flex items-center gap-3 flex-wrap justify-between">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-black text-slate-900 truncate flex items-center gap-2 flex-wrap">
                    {u.email}
                    {u.status === 'disabled' && (
                      <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-rose-50 text-rose-600">Disabled</span>
                    )}
                  </p>
                  <p className="text-[10px] font-semibold text-slate-400 mt-0.5">
                    {u.site_name} · {u.last_login_at ? `Last login ${timeAgo(u.last_login_at)}` : 'Never logged in'} · Created {timeAgo(u.created_at)}
                  </p>
                </div>
                <div className="shrink-0 flex items-center gap-2">
                  <select value={u.role} disabled={!!roleSaving[u.id]} onChange={(e) => changeRole(u, e.target.value)}
                    className="text-[10px] font-bold text-slate-700 border border-slate-200/80 rounded-lg px-2 py-1.5 bg-white disabled:opacity-60">
                    {ALL_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </select>
                  {u.status !== 'disabled' && (
                    <button type="button" onClick={() => disable(u)} disabled={!!disabling[u.id]}
                      className="shrink-0 text-slate-400 hover:text-rose-600 transition p-1.5 disabled:opacity-60" title="Disable user">
                      <Ban size={14} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
