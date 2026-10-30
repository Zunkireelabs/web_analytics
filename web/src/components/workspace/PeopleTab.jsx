import { useEffect, useState } from 'react';
import { Users, UserPlus, X, Mail, ShieldCheck } from 'lucide-react';
import { api, timeAgo } from '../../api.js';
import Avatar from '../Avatar.jsx';
import Badge from '../Badge.jsx';
import Button from '../Button.jsx';
import RichSelect from '../RichSelect.jsx';
import SettingsCard from '../settings/SettingsCard.jsx';
import GiveAccessModal from './GiveAccessModal.jsx';
import { STATUS } from '../../lib/palette.js';
import { PERMISSIONS, SCOPED_PERMISSIONS, ROLE_LABELS } from '../../lib/workspace.js';
import { siteInitials } from '../../lib/nav.js';

const projectRoleOptions = ['admin', 'member'].map((value) => ({ value, label: SCOPED_PERMISSIONS[value].label, description: SCOPED_PERMISSIONS[value].description }));

const roleOptions = (actorIsOwner) => ['owner', 'admin', 'member']
  .filter((r) => r !== 'owner' || actorIsOwner)
  .map((value) => ({ value, label: PERMISSIONS[value].label, description: PERMISSIONS[value].description }));

function GroupHead({ title, note }) {
  return (
    <div className="px-5 pt-3 pb-1.5 border-b border-border" style={{ background: '#fcfcfb' }}>
      <span className="text-[11px] font-medium tracking-[.08em] uppercase text-faint">{title}</span>
      {note && <span className="text-xs text-faint ml-2">{note}</span>}
    </div>
  );
}

// Who can open this workspace and what they can do. Anyone in the workspace can
// read the list; giving access, changing it and removing people show only for an
// owner or admin, and the server enforces the same boundary on its own.
export default function PeopleTab({ workspace, role, onChanged }) {
  const [data, setData] = useState(null); // { yourRole, members, invitations }
  const [error, setError] = useState(null);
  const [giveOpen, setGiveOpen] = useState(false);
  const [saving, setSaving] = useState({});
  const wsId = workspace.id;
  const platform = role === 'platform';

  const load = () => api.workspace.members(wsId).then(setData).catch((e) => setError(e.message || 'Could not load the people in this workspace.'));
  useEffect(() => { setData(null); setError(null); load(); }, [wsId]);

  const actorRole = data?.yourRole;
  const manage = actorRole === 'owner' || actorRole === 'admin';
  const actorIsOwner = actorRole === 'owner';

  const changeRole = async (m, next) => {
    if (next === m.role) return;
    setSaving((s) => ({ ...s, [m.id]: true }));
    try { await api.workspace.setRole(wsId, m.id, next); await load(); } catch (err) { setError(err.message || 'Could not change that person’s access.'); }
    setSaving((s) => ({ ...s, [m.id]: false }));
  };
  const changeProjectRole = async (m, next) => {
    if (next === m.role) return;
    const key = `p${m.project.id}:${m.id}`;
    setSaving((x) => ({ ...x, [key]: true }));
    try { await api.project.setRole(m.project.id, m.id, next); await load(); } catch (err) { setError(err.message || 'Could not change that person’s access.'); }
    setSaving((x) => ({ ...x, [key]: false }));
  };
  const removeProjectAccess = async (m) => {
    if (!confirm(`Remove ${m.email}’s access to ${m.project.name}? They lose it immediately.`)) return;
    const key = `p${m.project.id}:${m.id}`;
    setSaving((x) => ({ ...x, [key]: true }));
    try { await api.project.remove(m.project.id, m.id); await load(); await onChanged?.(); } catch (err) { setError(err.message || 'Could not remove that person.'); }
    setSaving((x) => ({ ...x, [key]: false }));
  };
  const remove = async (m) => {
    if (!confirm(`Remove ${m.email} from ${workspace.name}? They lose access to all of its projects immediately.`)) return;
    setSaving((s) => ({ ...s, [m.id]: true }));
    try { await api.workspace.remove(wsId, m.id); await load(); await onChanged?.(); } catch (err) { setError(err.message || 'Could not remove that person.'); }
    setSaving((s) => ({ ...s, [m.id]: false }));
  };

  return (
    <div>
      <SettingsCard icon={Users} title="People with access"
        description={manage ? `Everyone who can open ${workspace.name}, and what they can do.` : 'Everyone who can open this workspace.'}
        action={manage && <Button variant="light" onClick={() => setGiveOpen(true)}><UserPlus size={14} />Give access</Button>}>
        {error && <div className="mx-5 my-3 rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2">{error}</div>}
        {!data ? (
          [0, 1].map((i) => <div key={i} className="px-5 py-3 border-b border-border last:border-0"><div className="h-5 bg-muted rounded-control animate-pulse" /></div>)
        ) : (
          <div>
            {(data.projectMembers?.length > 0) && <GroupHead title="Whole workspace" note="see every project" />}
            {data.members.map((m) => {
              const editable = manage && !(m.role === 'owner' && !actorIsOwner) && m.role !== 'owner';
              return (
                <div key={m.id} className="flex items-center gap-3 px-5 py-3 border-b border-border last:border-0">
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" title={m.status === 'disabled' ? 'Disabled' : 'Active'}
                    style={{ background: m.status === 'disabled' ? STATUS.critical.color : STATUS.good.color }} />
                  <Avatar email={m.email} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium text-fg truncate">{m.email}</p>
                    <p className="text-xs text-faint">{m.last_login_at ? `Last active ${timeAgo(m.last_login_at)}` : 'Never logged in'}</p>
                  </div>
                  {m.status === 'disabled' && <Badge tone="red" className="shrink-0">Disabled</Badge>}
                  {editable ? (
                    <div className="shrink-0 w-[130px]"><RichSelect block align="right" label={`Access for ${m.email}`} value={m.role} disabled={!!saving[m.id]}
                      onChange={(r) => changeRole(m, r)} options={roleOptions(actorIsOwner)} /></div>
                  ) : <Badge tone="grey" className="shrink-0">{ROLE_LABELS[m.role] || m.role}</Badge>}
                  {manage && m.role !== 'owner' ? (
                    <Button variant="ghost" size="sm" icon title="Remove access" aria-label={`Remove ${m.email}`} disabled={!!saving[m.id]} onClick={() => remove(m)}><X size={14} /></Button>
                  ) : <span className="w-6 shrink-0" aria-hidden />}
                </div>
              );
            })}
            {data.projectMembers?.length > 0 && (
              <>
                <GroupHead title="Project access only" note="see only the project shown" />
                {data.projectMembers.map((m) => {
                  const key = `p${m.project.id}:${m.id}`;
                  return (
                    <div key={key} className="flex items-center gap-3 px-5 py-3 border-b border-border last:border-0">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" title={m.status === 'disabled' ? 'Disabled' : 'Active'} style={{ background: m.status === 'disabled' ? STATUS.critical.color : STATUS.good.color }} />
                      <Avatar email={m.email} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium text-fg truncate">{m.email}</p>
                        <p className="text-xs text-faint">{m.last_login_at ? `Last active ${timeAgo(m.last_login_at)}` : 'Never logged in'}</p>
                      </div>
                      <span className="hidden sm:inline-flex shrink-0 items-center gap-1.5 text-xs text-text rounded-control px-1.5 h-[22px]" style={{ boxShadow: 'var(--ring)' }}>
                        <span className="w-3.5 h-3.5 bg-primary text-white text-[6px] font-medium grid place-items-center" style={{ borderRadius: 4 }}>{siteInitials(m.project.name)}</span>{m.project.name} only
                      </span>
                      {manage ? (
                        <div className="shrink-0 w-[130px]"><RichSelect block align="right" label={`Access for ${m.email}`} value={m.role} disabled={!!saving[key]}
                          onChange={(r) => changeProjectRole(m, r)} options={projectRoleOptions} /></div>
                      ) : <Badge tone="grey" className="shrink-0">{ROLE_LABELS[m.role] || m.role}</Badge>}
                      {manage ? <Button variant="ghost" size="sm" icon title="Remove access" aria-label={`Remove ${m.email}`} disabled={!!saving[key]} onClick={() => removeProjectAccess(m)}><X size={14} /></Button> : <span className="w-6 shrink-0" aria-hidden />}
                    </div>
                  );
                })}
              </>
            )}
            {!platform && (
              <div className="flex items-center gap-3 px-5 py-3 border-b border-border last:border-0">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: STATUS.good.color }} />
                <span className="w-7 h-7 rounded-full grid place-items-center bg-muted text-text shrink-0"><ShieldCheck size={14} /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-fg truncate">Zunkiree platform support</p>
                  <p className="text-xs text-faint">Can open this workspace to help you · cannot be removed</p>
                </div>
                <Badge tone="outline" className="shrink-0">Support</Badge><span className="w-6 shrink-0" aria-hidden />
              </div>
            )}
            {data.invitations.map((inv) => (
              <div key={inv.id} className="flex items-center gap-3 px-5 py-3 border-b border-border last:border-0">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: STATUS.warning.color }} />
                <span className="w-7 h-7 rounded-full bg-muted text-faint grid place-items-center shrink-0"><Mail size={13} aria-hidden /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-fg truncate">{inv.email}</p>
                  <p className="text-xs text-faint">Invited {timeAgo(inv.created_at)} · waiting to accept</p>
                </div>
                <Badge tone="amber" className="shrink-0">Invited</Badge>
                {inv.project_site_ids?.length > 0 && <span className="hidden sm:inline text-xs text-text shrink-0">{inv.project_site_ids.map((id) => workspace.projects.find((p) => p.id === id)?.name).filter(Boolean).join(', ')} only</span>}
                <Badge tone="outline" className="shrink-0">{ROLE_LABELS[inv.role] || inv.role}</Badge><span className="w-6 shrink-0" aria-hidden />
              </div>
            ))}
          </div>
        )}
      </SettingsCard>

      <div className="tray mt-3"><div className="tray-card">
        <div className="px-5 py-3 border-b border-border text-[13px] font-medium text-fg">What each permission means</div>
        {['owner', 'admin', 'member'].map((k) => (
          <div key={k} className="flex items-baseline gap-3 px-5 py-2.5 border-b border-border last:border-0">
            <span className="w-20 shrink-0 text-[13px] font-medium text-fg">{PERMISSIONS[k].label}</span>
            <span className="text-[13px] text-text">{PERMISSIONS[k].description}</span>
          </div>
        ))}
      </div></div>

      {manage && <GiveAccessModal workspace={workspace} actorRole={platform ? 'platform' : actorRole} isOpen={giveOpen}
        onClose={() => setGiveOpen(false)} onDone={async () => { await load(); await onChanged?.(); }} />}
    </div>
  );
}
