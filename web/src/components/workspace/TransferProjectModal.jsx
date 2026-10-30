import { useEffect, useState } from 'react';
import { ArrowLeftRight, Check, ShieldCheck } from 'lucide-react';
import { api } from '../../api.js';
import Modal from '../Modal.jsx';
import Button from '../Button.jsx';
import Field from '../Field.jsx';
import ChoiceCard from './ChoiceCard.jsx';
import { canManageWorkspace } from '../../lib/workspace.js';

// Move a project, with its goal, API tokens and history, to another workspace the
// person manages (or to a brand-new one). By default everyone who can open it now
// keeps access to just that project, so nobody is locked out by the move.
export default function TransferProjectModal({ project, isOpen, onClose, onDone }) {
  const [targets, setTargets] = useState(null);
  const [to, setTo] = useState(null); // workspace id, or 'new'
  const [newName, setNewName] = useState('');
  const [keepAccess, setKeepAccess] = useState(true);
  const [state, setState] = useState('idle');
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!isOpen) return;
    api.workspaces().then((r) => {
      const list = (r.workspaces || []).filter((w) => canManageWorkspace(w.role) && w.id !== project.workspaceId);
      setTargets(list);
      setTo(list[0]?.id ?? 'new');
    }).catch(() => { setTargets([]); setTo('new'); });
  }, [isOpen, project?.workspaceId]);

  const close = () => { setTargets(null); setTo(null); setNewName(''); setKeepAccess(true); setState('idle'); setError(null); onClose(); };
  const submit = async () => {
    setState('saving'); setError(null);
    try {
      let target = to;
      if (to === 'new') target = (await api.workspace.create({ name: newName.trim() })).workspace.id;
      const res = await api.project.transfer(project.id, { toWorkspaceId: target, keepAccess });
      await onDone?.(res);
      close();
    } catch (err) { setError(err.message || 'Could not transfer the project.'); setState('error'); }
  };

  return (
    <Modal isOpen={isOpen} onClose={close} icon={ArrowLeftRight} title="Transfer project" maxWidth="max-w-[520px]"
      subtitle={<><span className="text-fg font-medium">{project?.name}</span>{project?.workspaceName ? ` · from ${project.workspaceName}` : ''}</>}
      footer={<><Button variant="light" onClick={close}>Cancel</Button>
        <Button variant="primary" onClick={submit} disabled={state === 'saving' || to == null || (to === 'new' && !newName.trim())}><ArrowLeftRight size={14} />{state === 'saving' ? 'Transferring…' : 'Transfer project'}</Button></>}>
      <div>
        <div className="text-[13px] font-medium text-fg mb-2">Move it to</div>
        <div role="radiogroup" className="space-y-2">
          {targets === null && <div className="h-12 bg-muted rounded-card animate-pulse" />}
          {(targets || []).map((w) => <ChoiceCard key={w.id} selected={to === w.id} onSelect={() => setTo(w.id)} title={w.name} description={w.role === 'platform' ? 'You can manage every workspace' : `You are ${w.role === 'owner' ? 'an owner' : 'an admin'} of this workspace`} />)}
          {targets !== null && <ChoiceCard selected={to === 'new'} onSelect={() => setTo('new')} title="A new workspace…" description="Create a workspace and move the project into it">
            {to === 'new' && <span className="block mt-2.5" onClick={(e) => e.stopPropagation()}><Field label="Workspace name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Acme Corp" autoFocus /></span>}
          </ChoiceCard>}
        </div>
      </div>
      <label className="flex items-start gap-2.5 text-[13px] text-text cursor-pointer">
        <span role="checkbox" aria-checked={keepAccess} tabIndex={0} onClick={() => setKeepAccess((k) => !k)} onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setKeepAccess((k) => !k); } }}
          className="w-4 h-4 mt-0.5 shrink-0 grid place-items-center" style={{ borderRadius: 4, ...(keepAccess ? { background: 'var(--primary)', color: '#fff' } : { boxShadow: '0 0 0 1px var(--input)' }) }}>{keepAccess && <Check size={11} strokeWidth={2.5} />}</span>
        <span><b className="font-medium text-fg">Keep access for people who can open it now.</b> They keep this project only, shown under “Shared with you”.</span>
      </label>
      {error && <div className="rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2">{error}</div>}
      <div className="flex items-start gap-2.5 rounded-control bg-muted px-3 py-2.5 text-[13px] leading-5 text-text">
        <ShieldCheck size={15} className="text-faint shrink-0 mt-0.5" />
        <span>The goal, API tokens and history move with the project. Zunkiree platform support keeps access.</span>
      </div>
    </Modal>
  );
}
