import { useEffect, useRef, useState } from 'react';
import { api, timeAgo } from '../api.js';
import { Users, UserPlus, Mail, Ban, MoreHorizontal } from 'lucide-react';
import Avatar from './Avatar.jsx';

const inputCls = 'w-full text-base sm:text-xs border border-slate-200/80 rounded-xl px-3.5 py-2.5 bg-slate-50/50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#6C63FF]/10 focus:border-[#6C63FF] transition duration-150 font-medium text-slate-800 placeholder:text-slate-400';
const labelCls = 'block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5';

// Mirrors login.js's TENANT_ROLE_RANK — a Tenant Admin can only ever grant a
// tenant-tier role to their own tenant's users (PLATFORM-ADMIN-DESIGN.md §E);
// platform tiers are only reachable from admin/Users.jsx.
const TENANT_ROLES = ['tenant_admin', 'tenant_member'];
const ROLE_LABELS = { tenant_admin: 'Tenant Admin', tenant_member: 'Tenant Member' };

function RowMenu({ user, roleSaving, disabling, onChangeRole, onDisable }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div className="relative shrink-0" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition p-1.5 rounded-lg" title="More actions">
        <MoreHorizontal size={15} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-52 bg-white border border-slate-200 rounded-xl shadow-lg p-2 z-20 space-y-2">
          <label className="block px-1">
            <span className={labelCls}>Role</span>
            <select value={user.role} disabled={!!roleSaving[user.id]} onChange={(e) => onChangeRole(user, e.target.value)}
              className="w-full text-[11px] font-bold text-slate-700 border border-slate-200/80 rounded-lg px-2 py-1.5 bg-white disabled:opacity-60">
              {TENANT_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
          </label>
          {user.status !== 'disabled' && (
            <button type="button" onClick={() => { setOpen(false); onDisable(user); }} disabled={!!disabling[user.id]}
              className="w-full flex items-center gap-2 text-[11px] font-bold text-rose-600 hover:bg-rose-50 rounded-lg px-2 py-1.5 transition disabled:opacity-60">
              <Ban size={12} /> Remove from team
            </button>
          )}
        </div>
      )}
    </div>
  );
}

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
        <form onSubmit={submitInvite} className="mb-5 space-y-3 bg-slate-50/60 border border-slate-100 rounded-xl p-4">
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
        <div className="space-y-1.5">
          {users.map((u) => (
            <div key={u.id} className="flex items-center gap-3 border border-transparent hover:border-slate-100 hover:bg-slate-50/60 hover:shadow-sm rounded-xl px-2.5 py-2 transition">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${u.status === 'disabled' ? 'bg-rose-400' : 'bg-emerald-400'}`} title={u.status === 'disabled' ? 'Disabled' : 'Active'} />
              <Avatar email={u.email} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-slate-800 truncate">{u.email}</p>
                <p className="text-[10px] font-semibold text-slate-400 mt-0.5">
                  {u.last_login_at ? `Last active ${timeAgo(u.last_login_at)}` : 'Never logged in'}
                </p>
              </div>
              {u.status === 'disabled' && (
                <span className="shrink-0 text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-rose-50 text-rose-600">Disabled</span>
              )}
              <span className="shrink-0 text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-500">
                {ROLE_LABELS[u.role] || u.role}
              </span>
              {isAdmin && (
                <RowMenu user={u} roleSaving={roleSaving} disabling={disabling} onChangeRole={changeRole} onDisable={disable} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
