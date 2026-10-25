import { useEffect, useRef, useState } from 'react';
import { api, timeAgo } from '../api.js';
import { Users, Ban, MoreHorizontal, UserPlus, Info, Mail } from 'lucide-react';
import Avatar from './Avatar.jsx';
import Badge from './Badge.jsx';
import Button from './Button.jsx';
import Field from './Field.jsx';
import Modal from './Modal.jsx';
import RichSelect from './RichSelect.jsx';
import SettingsCard from './settings/SettingsCard.jsx';
import { STATUS } from '../lib/palette.js';
import { siteInitials } from '../lib/nav.js';

// Workspace roles, highest first. The server is the real gate (every route
// checks the caller's role in THIS workspace); this only decides which
// controls to show. Owner is only offered to an owner — an admin cannot grant it.
const ROLE_LABELS = { owner: 'Owner', admin: 'Admin', member: 'Member' };
const ROLE_DESCRIPTIONS = {
  owner: 'Full control, including billing-level changes and other owners.',
  admin: 'Can add projects, invite teammates, change roles and remove members.',
  member: "Can use every project in the workspace; can't manage it.",
};

const roleOptions = (actorRole) => ['owner', 'admin', 'member']
  .filter((r) => r !== 'owner' || actorRole === 'owner')
  .map((value) => ({ value, label: ROLE_LABELS[value], description: ROLE_DESCRIPTIONS[value] }));

function RowMenu({ member, actorRole, roleSaving, removing, onChangeRole, onRemove }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  // An admin cannot change or remove an owner — hide the menu rather than offer a button the server will refuse.
  const locked = member.role === 'owner' && actorRole !== 'owner';

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

  if (locked) return <span className="w-8 shrink-0" aria-hidden />;

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
            <RichSelect block align="left" label="Role" value={member.role} disabled={!!roleSaving[member.id]}
              onChange={(r) => onChangeRole(member, r)} options={roleOptions(actorRole)} />
          </div>
          <button type="button" onClick={() => { setOpen(false); onRemove(member); }} disabled={!!removing[member.id]}
            className="w-full flex items-center gap-2 h-8 px-2 rounded-control text-[13px] text-[#b42318] hover:bg-[#fdecec] disabled:opacity-60">
            <Ban size={13} /> Remove from workspace
          </button>
        </div>
      )}
    </div>
  );
}

// Members of one workspace. Anyone in the workspace can read the list; invite,
// role changes and removal render only for an owner or admin, and the server
// enforces the same boundary independently (server/routes/workspaces.js).
export default function TeamCard({ workspace }) {
  const [data, setData] = useState(null); // null = loading: { yourRole, members, invitations }
  const [error, setError] = useState(null);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [inviteState, setInviteState] = useState('idle');
  const [inviteError, setInviteError] = useState(null);

  const [roleSaving, setRoleSaving] = useState({});
  const [removing, setRemoving] = useState({});

  const workspaceId = workspace?.id;
  const load = () => api.workspace.members(workspaceId).then(setData).catch((e) => setError(e.message || 'Could not load your team.'));

  useEffect(() => { setData(null); setError(null); if (workspaceId) load(); }, [workspaceId]);

  const actorRole = data?.yourRole;
  const isAdmin = actorRole === 'owner' || actorRole === 'admin';

  const closeInvite = () => {
    setInviteOpen(false);
    setInviteEmail('');
    setInviteRole('member');
    setInviteError(null);
    setInviteState('idle');
  };

  const submitInvite = async (e) => {
    e.preventDefault();
    setInviteState('sending');
    setInviteError(null);
    try {
      await api.workspace.invite(workspaceId, { email: inviteEmail.trim(), role: inviteRole });
      closeInvite();
      await load();
    } catch (err) {
      setInviteError(err.message || 'Could not send invitation.');
      setInviteState('error');
    }
  };

  const changeRole = async (member, newRole) => {
    if (newRole === member.role) return;
    setRoleSaving((s) => ({ ...s, [member.id]: true }));
    try {
      await api.workspace.setRole(workspaceId, member.id, newRole);
      await load();
    } catch (err) {
      setError(err.message || 'Could not change role.');
    } finally {
      setRoleSaving((s) => ({ ...s, [member.id]: false }));
    }
  };

  const remove = async (member) => {
    if (!confirm(`Remove ${member.email} from ${workspace.name}? They lose access to all of its projects immediately.`)) return;
    setRemoving((s) => ({ ...s, [member.id]: true }));
    try {
      await api.workspace.remove(workspaceId, member.id);
      await load();
    } catch (err) {
      setError(err.message || 'Could not remove member.');
    } finally {
      setRemoving((s) => ({ ...s, [member.id]: false }));
    }
  };

  const projects = workspace?.projects || [];

  return (
    <SettingsCard icon={Users} title="Members"
      description={isAdmin ? `Invite teammates to ${workspace?.name || 'this workspace'} and manage their access` : 'Everyone with access to this workspace'}
      action={isAdmin && (
        <Button variant="light" onClick={() => setInviteOpen(true)}><UserPlus size={14} />Invite</Button>
      )}>
      {error && (
        <div className="mx-5 my-3 rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2">{error}</div>
      )}

      {!data ? (
        <div>
          {[0, 1].map((i) => (
            <div key={i} className="px-5 py-3 border-b border-border last:border-0"><div className="h-5 bg-muted rounded-control animate-pulse" /></div>
          ))}
        </div>
      ) : data.members.length === 0 ? (
        <div className="px-5 py-8 text-center text-[13px] text-faint">No teammates yet.</div>
      ) : (
        <div>
          {data.members.map((m) => (
            <div key={m.id} className="flex items-center gap-3 px-5 py-3 border-b border-border last:border-0">
              <span className="w-1.5 h-1.5 rounded-full shrink-0" title={m.status === 'disabled' ? 'Disabled' : 'Active'}
                style={{ background: m.status === 'disabled' ? STATUS.critical.color : STATUS.good.color }} />
              <Avatar email={m.email} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-fg truncate">{m.email}</p>
                <p className="text-xs text-faint">
                  {m.last_login_at ? `Last active ${timeAgo(m.last_login_at)}` : 'Never logged in'}
                </p>
              </div>
              {m.status === 'disabled' && <Badge tone="red" className="shrink-0">Disabled</Badge>}
              <Badge tone="grey" className="shrink-0">{ROLE_LABELS[m.role] || m.role}</Badge>
              {isAdmin && (
                <RowMenu member={m} actorRole={actorRole} roleSaving={roleSaving} removing={removing}
                  onChangeRole={changeRole} onRemove={remove} />
              )}
            </div>
          ))}
        </div>
      )}

      {data?.invitations?.length > 0 && (
        <div className="border-t border-border">
          <div className="px-5 pt-3 pb-1 text-[11px] font-medium tracking-[.08em] uppercase text-faint">Pending invitations</div>
          {data.invitations.map((inv) => (
            <div key={inv.id} className="flex items-center gap-3 px-5 py-2.5 border-b border-border last:border-0">
              <span className="w-7 h-7 rounded-full bg-muted text-faint grid place-items-center shrink-0"><Mail size={13} aria-hidden /></span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-fg truncate">{inv.email}</p>
                <p className="text-xs text-faint">Invited {timeAgo(inv.created_at)} · expires {new Date(inv.expires_at).toLocaleDateString()}</p>
              </div>
              <Badge tone="outline" className="shrink-0">{ROLE_LABELS[inv.role] || inv.role}</Badge>
            </div>
          ))}
        </div>
      )}

      {isAdmin && (
        <Modal isOpen={inviteOpen} onClose={closeInvite} icon={Users} title="Invite team member"
          subtitle={<>Invite to <span className="text-fg font-medium">{workspace?.name}</span></>} maxWidth="max-w-[520px]"
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
              <div className="text-[13px] font-medium text-fg">Role in this workspace</div>
              <div className="text-xs text-faint">Applies to every project below</div>
              <div className="mt-2">
                <RichSelect block label="Role" value={inviteRole} onChange={setInviteRole} options={roleOptions(actorRole)} />
              </div>
              {projects.length > 0 && (
                <div className="mt-2">
                  {projects.map((p) => (
                    <div key={p.id} className="flex items-center gap-2.5 py-2 border-b border-border last:border-0">
                      <span className="w-6 h-6 rounded-[7px] bg-primary text-white text-[10px] font-medium grid place-items-center shrink-0">{siteInitials(p.name)}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-medium text-fg truncate">{p.name}</div>
                        {p.domain && <div className="text-xs text-faint truncate">{p.domain}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {inviteState === 'error' && inviteError && (
              <div className="rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2">{inviteError}</div>
            )}

            <div className="flex items-start gap-2.5 rounded-control bg-muted px-3 py-2.5 text-[13px] leading-5 text-text">
              <Info size={15} className="text-faint shrink-0 mt-0.5" />
              <span>New people get an email with a link to join. Someone who already has an account is added straight away.</span>
            </div>
          </form>
        </Modal>
      )}
    </SettingsCard>
  );
}
