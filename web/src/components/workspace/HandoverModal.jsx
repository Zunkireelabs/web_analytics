import { useState } from 'react';
import { ArrowLeftRight, ShieldCheck } from 'lucide-react';
import { api } from '../../api.js';
import Modal from '../Modal.jsx';
import Button from '../Button.jsx';
import Field from '../Field.jsx';
import PermissionCards from './PermissionCards.jsx';
import { plural } from '../../lib/workspace.js';

// Hand a workspace to someone else. The platform admin keeps support access
// either way (it never depends on a membership row).
export default function HandoverModal({ workspace, workspaceRole, isOpen, onClose, onDone }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('owner');
  const [transfer, setTransfer] = useState(false);
  const [state, setState] = useState('idle');
  const [error, setError] = useState(null);
  const isMemberOwner = workspaceRole === 'owner'; // a real owner, not the platform admin helping out

  const close = () => { setEmail(''); setRole('owner'); setTransfer(false); setState('idle'); setError(null); onClose(); };
  const submit = async (e) => {
    e.preventDefault();
    setState('saving'); setError(null);
    try { await api.workspace.handover(workspace.id, { email: email.trim(), role, transfer: transfer && role === 'owner' }); await onDone?.(); close(); }
    catch (err) { setError(err.message || 'Could not hand over the workspace.'); setState('error'); }
  };

  return (
    <Modal isOpen={isOpen} onClose={close} icon={ArrowLeftRight} title="Hand over workspace" maxWidth="max-w-[520px]"
      subtitle={<>{workspace?.name} · {plural(workspace?.projects?.length || 0, 'project', 'projects')}</>}
      footer={<><Button variant="light" onClick={close}>Cancel</Button>
        <Button type="submit" form="handover-form" variant="primary" disabled={!email.trim() || state === 'saving'}><ArrowLeftRight size={14} />{state === 'saving' ? 'Handing over…' : 'Hand over'}</Button></>}>
      <form id="handover-form" onSubmit={submit} className="space-y-4">
        <Field label="Hand over to" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="owner@company.com" required autoFocus
          hint="They get an email with a link to take over." />
        <div>
          <div className="text-[13px] font-medium text-fg mb-2">What can they do?</div>
          <PermissionCards value={role} onChange={setRole} withOwner />
        </div>
        {isMemberOwner && role === 'owner' && (
          <label className="flex items-start gap-2.5 text-[13px] text-text cursor-pointer">
            <input type="checkbox" checked={transfer} onChange={(e) => setTransfer(e.target.checked)} className="mt-0.5" />
            <span>Step down to Admin once they have taken over.</span>
          </label>
        )}
        {error && <div className="rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2">{error}</div>}
        <div className="flex items-start gap-2.5 rounded-control bg-muted px-3 py-2.5 text-[13px] leading-5 text-text">
          <ShieldCheck size={15} className="text-faint shrink-0 mt-0.5" />
          <span><b className="font-medium text-fg">Zunkiree platform support always keeps access.</b> After the handover we can still open this workspace to help, and the new owner cannot remove that.</span>
        </div>
      </form>
    </Modal>
  );
}
