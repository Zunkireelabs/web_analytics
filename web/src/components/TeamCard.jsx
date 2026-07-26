import { useEffect, useState } from 'react';
import { api, timeAgo } from '../api.js';
import { Users, UserPlus, Mail, Ban } from 'lucide-react';

const inputCls = 'w-full text-base sm:text-xs border border-slate-200/80 rounded-xl px-3.5 py-2.5 bg-slate-50/50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#6C63FF]/10 focus:border-[#6C63FF] transition duration-150 font-medium text-slate-800 placeholder:text-slate-400';
const labelCls = 'block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5';

// Mirrors login.js's TENANT_ROLE_RANK — a Tenant Admin can only ever grant a
// tenant-tier role to their own tenant's users (PLATFORM-ADMIN-DESIGN.md §E);
// platform tiers are only reachable from admin/Users.jsx.
const TENANT_ROLES = ['tenant_admin', 'tenant_member'];
const ROLE_LABELS = { tenant_admin: 'Tenant Admin', tenant_member: 'Tenant Member' };

// Visible to every tenant user (own-tenant read is unrestricted), but the
// invite/role-change/disable controls only render for a Tenant Admin — the
// same boundary the server enforces independently via requireTenantRole
// (server/routes/users.js), this is UX, not the real access-control layer.
export default function TeamCard({ role }) {
  const isAdmin = role === 'tenant_admin';
  const [users, setUsers] = useState(null); // null = loading
  const [error, setError] = useState(null);

  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('tenant_member');
  const [inviteState, setInviteState] = useState('idle');
  const [inviteError, setInviteError] = useState(null);

  const [roleSaving, setRoleSaving] = useState({});
  const [disabling, setDisabling] = useState({});

  const load = () => api.team.list().then(setUsers).catch((e) => setError(e.message || 'Could not load your team.'));

  useEffect(() => { load(); }, []);

  const submitInvite = async (e) => {
    e.preventDefault();
    setInviteState('sending');
    setInviteError(null);
    try {
      await api.team.invite({ email: inviteEmail.trim(), role: inviteRole });
      setInviteEmail('');
      setInviteRole('tenant_member');
      setShowInvite(false);
      setInviteState('idle');
      await load();
    } catch (err) {
      setInviteError(err.message || 'Could not send invitation.');
      setInviteState('error');
    }
  };

  const changeRole = async (user, newRole) => {
    if (newRole === user.role) return;
    setRoleSaving((s) => ({ ...s, [user.id]: true }));
    try {
      await api.team.updateRole(user.id, newRole);
      await load();
    } catch (err) {
      setError(err.message || 'Could not change role.');
    } finally {
      setRoleSaving((s) => ({ ...s, [user.id]: false }));
    }
  };

  const disable = async (user) => {
    if (!confirm(`Remove ${user.email} from your team? They will be logged out and lose access immediately.`)) return;
    setDisabling((s) => ({ ...s, [user.id]: true }));
    try {
      await api.team.disable(user.id);
      await load();
    } catch (err) {
      setError(err.message || 'Could not remove user.');
    } finally {
      setDisabling((s) => ({ ...s, [user.id]: false }));
    }
  };

  return (
    <div className="bg-white/70 border border-slate-200/50 backdrop-blur-md shadow-sm rounded-2xl p-6">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
        <h2 className="text-sm font-black text-slate-900 flex items-center gap-2">
          <Users size={15} className="text-[#6C63FF]" /> Team
        </h2>
        {isAdmin && (
          <button type="button" onClick={() => setShowInvite((s) => !s)}
            className="text-[10px] font-black uppercase tracking-wider px-3.5 py-2 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-650 transition flex items-center gap-1.5">
            {showInvite ? 'Cancel' : (<><UserPlus size={11} /><span>Invite</span></>)}
          </button>
        )}
      </div>
      <p className="text-xs text-slate-450 font-semibold mb-4">
        {isAdmin ? 'Invite teammates and manage their access.' : 'Everyone with access to this account.'}
      </p>

      {error && (
        <div className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2 mb-4">{error}</div>
      )}

      {isAdmin && showInvite && (
        <form onSubmit={submitInvite} className="mb-5 max-w-md space-y-3 bg-slate-50/60 border border-slate-100 rounded-xl p-4">
          <label className="block">
            <span className={labelCls}>Email</span>
            <div className="relative">
              <Mail size={13} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input type="email" className={`${inputCls} pl-9`} value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="name@example.com" required />
            </div>
          </label>
          <label className="block">
            <span className={labelCls}>Role</span>
            <select className={inputCls} value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
              {TENANT_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
          </label>
          {inviteState === 'error' && inviteError && (
            <div className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2">{inviteError}</div>
          )}
          <button type="submit" disabled={inviteState === 'sending'}
            className="text-[10px] font-black uppercase tracking-wider px-4 py-2.5 rounded-xl text-white transition disabled:opacity-60"
            style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>
            {inviteState === 'sending' ? 'Sending…' : 'Send Invitation'}
          </button>
        </form>
      )}

      {!users ? (
        <p className="text-xs text-slate-400 font-semibold">Loading…</p>
      ) : users.length === 0 ? (
        <p className="text-xs text-slate-400 font-semibold">No teammates yet.</p>
      ) : (
        <div className="space-y-2">
          {users.map((u) => (
            <div key={u.id} className="flex items-center justify-between gap-3 border border-slate-100 rounded-xl px-3.5 py-2.5">
              <div className="min-w-0">
                <p className="text-xs font-bold text-slate-800 truncate flex items-center gap-2 flex-wrap">
                  {u.email}
                  {u.status === 'disabled' && (
                    <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-rose-50 text-rose-600">Disabled</span>
                  )}
                </p>
                <p className="text-[10px] font-semibold text-slate-400 mt-0.5">
                  {u.last_login_at ? `Last login ${timeAgo(u.last_login_at)}` : 'Never logged in'}
                </p>
              </div>
              {isAdmin ? (
                <div className="shrink-0 flex items-center gap-2">
                  <select value={u.role} disabled={!!roleSaving[u.id]} onChange={(e) => changeRole(u, e.target.value)}
                    className="text-[10px] font-bold text-slate-700 border border-slate-200/80 rounded-lg px-2 py-1 bg-white disabled:opacity-60">
                    {TENANT_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </select>
                  {u.status !== 'disabled' && (
                    <button type="button" onClick={() => disable(u)} disabled={!!disabling[u.id]}
                      className="shrink-0 text-slate-400 hover:text-rose-600 transition p-1.5 disabled:opacity-60" title="Remove from team">
                      <Ban size={14} />
                    </button>
                  )}
                </div>
              ) : (
                <span className="shrink-0 text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-500">
                  {ROLE_LABELS[u.role] || u.role}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
