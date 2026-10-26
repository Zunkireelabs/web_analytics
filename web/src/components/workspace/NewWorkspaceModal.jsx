import { useState } from 'react';
import { Building2 } from 'lucide-react';
import { api } from '../../api.js';
import Modal from '../Modal.jsx';
import Field from '../Field.jsx';
import Button from '../Button.jsx';

// Creating a workspace is naming it, and nothing else — so it is a popup on the
// Projects page rather than a page of its own. Goals, people and connections all
// belong to a PROJECT, and asking for them here made a four-step flow out of one
// field. Afterwards the Projects page shows the new (empty) workspace with "Add
// your first project", which is where the real setup happens.
export default function NewWorkspaceModal({ isOpen, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [state, setState] = useState('idle');
  const [error, setError] = useState(null);

  const close = () => { setName(''); setState('idle'); setError(null); onClose(); };

  const submit = async (e) => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean) return;
    setState('saving');
    setError(null);
    try {
      // The server answers { workspace, project, access }; callers only want the workspace.
      const created = await api.workspace.create({ name: clean });
      const workspace = created.workspace || created;
      setState('idle');
      setName('');
      await onCreated?.(workspace);
      onClose();
    } catch (err) {
      setError(err.message || 'Could not create the workspace.');
      setState('error');
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={close} icon={Building2} title="New workspace"
      subtitle="A workspace holds your projects and the people who can see them." maxWidth="max-w-[440px]"
      footer={(
        <>
          <Button variant="light" onClick={close}>Cancel</Button>
          <Button type="submit" form="new-workspace-form" variant="primary" disabled={!name.trim() || state === 'saving'}>
            {state === 'saving' ? 'Creating…' : 'Create workspace'}
          </Button>
        </>
      )}>
      <form id="new-workspace-form" onSubmit={submit} className="space-y-4">
        <Field label="Workspace name" value={name} onChange={(e) => { setName(e.target.value); setError(null); }}
          placeholder="Acme Marketing" required autoFocus hint="Usually your company or team name. You can rename it later." />
        {state === 'error' && error && <div className="rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2">{error}</div>}
      </form>
    </Modal>
  );
}
