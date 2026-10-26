import { useEffect, useState } from 'react';
import { Settings as SettingsIcon, ShieldCheck, ArrowLeftRight } from 'lucide-react';
import { api } from '../../api.js';
import Avatar from '../Avatar.jsx';
import Badge from '../Badge.jsx';
import Button from '../Button.jsx';
import Field from '../Field.jsx';
import SettingsCard from '../settings/SettingsCard.jsx';
import HandoverModal from './HandoverModal.jsx';
import { plural } from '../../lib/workspace.js';

// Name, who owns the workspace and how to hand it over, the always-on support
// access, and (for owners) the delete zone.
export default function SettingsTab({ workspace, role, onChanged }) {
  const [name, setName] = useState(workspace.name);
  const [state, setState] = useState('idle');
  const [error, setError] = useState(null);
  const [owner, setOwner] = useState(null);
  const [handOpen, setHandOpen] = useState(false);
  const isOwner = role === 'owner' || role === 'platform';

  useEffect(() => { setName(workspace.name); setState('idle'); setError(null); }, [workspace.id, workspace.name]);
  const loadOwner = () => api.workspace.members(workspace.id).then((d) => setOwner(d.members.find((m) => m.role === 'owner') || null)).catch(() => {});
  useEffect(() => { setOwner(null); loadOwner(); }, [workspace.id]);

  const save = async (e) => {
    e.preventDefault();
    setState('saving'); setError(null);
    try { await api.workspace.rename(workspace.id, name.trim()); setState('saved'); await onChanged?.(); }
    catch (err) { setError(err.message || 'Could not rename the workspace.'); setState('error'); }
  };

  return (
    <div>
      <div className="space-y-3">
        <SettingsCard icon={SettingsIcon} title="General" description="The name people see in the project switcher.">
          <form onSubmit={save}>
            <div className="px-5 py-4"><Field label="Workspace name" value={name} onChange={(e) => { setName(e.target.value); setState('idle'); }} maxLength={120} required /></div>
            {error && <div className="mx-5 mb-3 rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2">{error}</div>}
            <div className="flex items-center justify-end gap-3 px-5 py-3 border-t border-border">
              {state === 'saved' && <span className="text-[13px] text-faint">Saved</span>}
              <Button type="submit" variant="primary" disabled={!name.trim() || name.trim() === workspace.name || state === 'saving'}>{state === 'saving' ? 'Saving…' : 'Save changes'}</Button>
            </div>
          </form>
        </SettingsCard>

        <SettingsCard icon={ShieldCheck} title="Ownership and support" description="Who owns this workspace and who can help you with it.">
          <div className="flex items-center gap-3 px-5 py-3 border-b border-border">
            {owner ? <Avatar email={owner.email} size="sm" /> : <span className="w-7 h-7 rounded-full bg-muted" />}
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-fg truncate">{owner?.email || 'Owner'}</p>
              <p className="text-xs text-faint">Owner. Can hand the workspace over to someone else.</p>
            </div>
            {isOwner && <Button variant="light" onClick={() => setHandOpen(true)}><ArrowLeftRight size={14} />Hand over</Button>}
          </div>
          <div className="flex items-center gap-3 px-5 py-3">
            <span className="w-7 h-7 rounded-full grid place-items-center bg-muted text-text shrink-0"><ShieldCheck size={14} /></span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-fg">Zunkiree platform support</p>
              <p className="text-xs text-faint">Can open this workspace to help you. This stays on after a hand-over and cannot be removed.</p>
            </div>
            <Badge tone="outline" className="shrink-0">Always on</Badge>
          </div>
        </SettingsCard>
      </div>

      {isOwner && (
        <div className="tray mt-3" style={{ boxShadow: '0 0 0 1px #fecdca' }}>
          <div className="tray-card">
            <div className="px-5 py-3.5 border-b border-border">
              <h2 className="text-[15px] font-semibold text-[#b42318]">Delete workspace</h2>
              <p className="text-[13px] text-text mt-0.5">Permanently delete {workspace.name}, its {plural(workspace.projects.length, 'project', 'projects')} and all their data. This cannot be undone.</p>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
              <p className="text-[13px] text-faint">Deleting a workspace is not available yet. Contact support and we will do it for you.</p>
              <button type="button" disabled aria-disabled className="btn" style={{ background: '#d92d20', color: '#fff' }}>Delete workspace</button>
            </div>
          </div>
        </div>
      )}
      <HandoverModal workspace={workspace} workspaceRole={role} isOpen={handOpen} onClose={() => setHandOpen(false)} onDone={async () => { await loadOwner(); await onChanged?.(); }} />
    </div>
  );
}
