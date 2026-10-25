import { useState } from 'react';
import { FolderPlus } from 'lucide-react';
import { api } from '../api.js';
import Modal from './Modal.jsx';
import Field from './Field.jsx';
import Button from './Button.jsx';

// Creates a project (site) inside a workspace. The workspace's members already
// have access to it, so there is no login to create here — just a name and an
// optional domain. The server checks the caller is an admin of the workspace.
export default function AddProjectModal({ workspace, isOpen, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [state, setState] = useState('idle');
  const [error, setError] = useState(null);

  const close = () => {
    setName(''); setDomain(''); setError(null); setState('idle');
    onClose();
  };

  const submit = async (e) => {
    e.preventDefault();
    setState('saving');
    setError(null);
    try {
      const project = await api.workspace.createProject(workspace.id, { name: name.trim(), websiteDomain: domain.trim() || undefined });
      setName(''); setDomain(''); setState('idle');
      await onCreated?.(project);
    } catch (err) {
      setError(err.message || 'Could not create the project.');
      setState('error');
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={close} icon={FolderPlus} title="Add project"
      subtitle={<>In <span className="text-fg font-medium">{workspace?.name}</span></>} maxWidth="max-w-[480px]"
      footer={(
        <>
          <Button variant="light" onClick={close}>Cancel</Button>
          <Button type="submit" form="add-project-form" variant="primary" disabled={state === 'saving' || !name.trim()}>
            {state === 'saving' ? 'Creating…' : 'Create project'}
          </Button>
        </>
      )}>
      <form id="add-project-form" onSubmit={submit} className="space-y-4">
        <Field label="Project name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Blog" required autoFocus />
        <Field label="Website domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="blog.acme.com"
          hint="Optional. You can connect Search Console and Analytics afterwards." />
        {state === 'error' && error && (
          <div className="rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2">{error}</div>
        )}
      </form>
    </Modal>
  );
}
