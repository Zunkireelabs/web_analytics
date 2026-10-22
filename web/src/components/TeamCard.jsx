import { useEffect, useRef, useState } from 'react';
import { api, timeAgo } from '../api.js';
import { Users, Ban, MoreHorizontal, UserPlus, Info } from 'lucide-react';
import Avatar from './Avatar.jsx';
import Badge from './Badge.jsx';
import Button from './Button.jsx';
import Field from './Field.jsx';
import Modal from './Modal.jsx';
import RichSelect from './RichSelect.jsx';
import { ROLE_LABELS } from './RoleBadge.jsx';
import SettingsCard from './settings/SettingsCard.jsx';
import { STATUS } from '../lib/palette.js';
import { siteInitials } from '../lib/nav.js';

// Mirrors login.js's TENANT_ROLE_RANK — a Tenant Admin can only ever grant a
// tenant-tier role to their own tenant's users (PLATFORM-ADMIN-DESIGN.md §E);
// platform tiers are only reachable from admin/Users.jsx.
const TENANT_ROLES = ['tenant_admin', 'tenant_member'];

const ROLE_OPTIONS = [
  { value: 'tenant_admin', label: 'Admin', description: 'Can invite teammates, change roles and remove members.' },
  { value: 'tenant_member', label: 'Member', description: "Can use the dashboard; can't manage the team." },
];

function RowMenu({ user, roleSaving, disabling, onChangeRole, onDisable }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      // A RichSelect menu is portalled outside this popover — clicking it must not close the popover.
      if (e.target.closest?.('[role="listbox"]')) return;
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDocClick); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div className="relative shrink-0" ref={ref}>
      <Button variant="ghost" size="sm" icon title="More actions" aria-label="More actions" onClick={() => setOpen((o) => !o)}>
        <MoreHorizontal size={14} />
      </Button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-56 bg-white rounded-card p-2 z-20 space-y-1"
          style={{ boxShadow: '0 0 0 1px rgba(0,0,0,.06), 0 20px 40px -12px rgba(0,0,0,.18)' }}>
          <div className="px-0.5">
            <span className="block text-xs font-medium text-fg mb-1">Role</span>
            <RichSelect block align="left" label="Role" value={user.role} disabled={!!roleSaving[user.id]}
              onChange={(r) => onChangeRole(user, r)} options={ROLE_OPTIONS} />
          </div>
          {user.status !== 'disabled' && (
            <button type="button" onClick={() => { setOpen(false); onDisable(user); }} disabled={!!disabling[user.id]}
              className="w-full flex items-center gap-2 h-8 px-2 rounded-control text-[13px] text-[#b42318] hover:bg-[#fdecec] disabled:opacity-60">
              <Ban size={13} /> Remove from team
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
export default function TeamCard({ role, workspaceName, projects, currentProjectId }) {
  const isAdmin = role === 'tenant_admin';
  const [users, setUsers] = useState(null); // null = loading
  const [error, setError] = useState(null);

  const [inviteOpen, setInviteOpen] = useState(false);
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
      setInviteState('idle');
      setInviteOpen(false);
      await load();
    } catch (err) {
      setInviteError(err.message || 'Could not send invitation.');
      setInviteState('error');
    }
  };

  const closeInvite = () => {
    setInviteOpen(false);
    setInviteEmail('');
    setInviteRole('tenant_member');
    setInviteError(null);
    setInviteState('idle');
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
    <SettingsCard icon={Users} title="Members"
      description={isAdmin ? `Invite teammates to ${workspaceName || 'this workspace'} and manage their access` : 'Everyone with access to this workspace'}
      action={isAdmin && (
        <Button variant="light" onClick={() => setInviteOpen(true)}><UserPlus size={14} />Invite</Button>
      )}>
      {error && (
        <div className="mx-5 my-3 rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2">{error}</div>
      )}

      {!users ? (
        <div>
          {[0, 1].map((i) => (
            <div key={i} className="px-5 py-3 border-b border-border last:border-0"><div className="h-5 bg-muted rounded-control animate-pulse" /></div>
          ))}
        </div>
      ) : users.length === 0 ? (
        <div className="px-5 py-8 text-center text-[13px] text-faint">No teammates yet.</div>
      ) : (
        <div>
          {users.map((u) => (
            <div key={u.id} className="flex items-center gap-3 px-5 py-3 border-b border-border last:border-0">
              <span className="w-1.5 h-1.5 rounded-full shrink-0" title={u.status === 'disabled' ? 'Disabled' : 'Active'}
                style={{ background: u.status === 'disabled' ? STATUS.critical.color : STATUS.good.color }} />
              <Avatar email={u.email} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-fg truncate">{u.email}</p>
                <p className="text-xs text-faint">
                  {u.last_login_at ? `Last active ${timeAgo(u.last_login_at)}` : 'Never logged in'}
                </p>
              </div>
              {u.status === 'disabled' && <Badge tone="red" className="shrink-0">Disabled</Badge>}
              <Badge tone="grey" className="shrink-0">{ROLE_LABELS[u.role] || u.role}</Badge>
              {isAdmin && (
                <RowMenu user={u} roleSaving={roleSaving} disabling={disabling} onChangeRole={changeRole} onDisable={disable} />
              )}
            </div>
          ))}
        </div>
      )}
      {isAdmin && (
        <Modal isOpen={inviteOpen} onClose={closeInvite} icon={Users} title="Invite team member"
          subtitle={<>Invite to <span className="text-fg font-medium">{workspaceName}</span></>} maxWidth="max-w-[520px]"
          footer={(
            <>
              <Button variant="light" onClick={closeInvite}>Cancel</Button>
              <Button type="submit" form="invite-form" variant="primary" disabled={inviteState === 'sending'}>
                {inviteState === 'sending' ? 'Sending…' : 'Send invitation'}
              </Button>
            </>
          )}>
          <form id="invite-form" onSubmit={submitInvite} className="space-y-4">
            <Field label="Email" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="colleague@company.com" required />

            <div>
              <div className="text-[13px] font-medium text-fg">Access per project</div>
              <div className="text-xs text-faint">What they can do in each project of this workspace</div>
              <div className="mt-1">
                {(projects?.length ? projects : [{ id: currentProjectId ?? 'current', name: workspaceName }]).map((p) => {
                  const isCurrent = projects?.length ? p.id === currentProjectId : true;
                  return (
                    <div key={p.id} className="flex items-center gap-2.5 py-2.5 border-b border-border last:border-0">
                      {p.logo ? (
                        <img src={p.logo} alt="" className="w-6 h-6 rounded-[7px] object-contain shrink-0" />
                      ) : (
                        <span className="w-6 h-6 rounded-[7px] bg-primary text-white text-[10px] font-medium grid place-items-center shrink-0">{siteInitials(p.name)}</span>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-medium text-fg truncate">{p.name}</div>
                        {p.domain && <div className="text-xs text-faint truncate">{p.domain}</div>}
                      </div>
                      {isCurrent ? (
                        <RichSelect label={`Access to ${p.name}`} value={inviteRole} onChange={setInviteRole} options={ROLE_OPTIONS} />
                      ) : (
                        <span title="Invite from that project's settings">
                          <RichSelect label={`Access to ${p.name}`} value="none" onChange={() => {}} disabled
                            options={[{ value: 'none', label: 'No access' }]} />
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {inviteState === 'error' && inviteError && (
              <div className="rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2">{inviteError}</div>
            )}

            <div className="flex items-start gap-2.5 rounded-control bg-muted px-3 py-2.5 text-[13px] leading-5 text-text">
              <Info size={15} className="text-faint shrink-0 mt-0.5" />
              <span>We'll email them a link to join. They get access once they accept.</span>
            </div>
          </form>
        </Modal>
      )}
    </SettingsCard>
  );
}
