import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api } from '../../api.js';
import Modal from '../Modal.jsx';
import Field from '../Field.jsx';
import Button from '../Button.jsx';

// Deleting a project: say plainly what happens, and make the person type its exact name, the same
// re-typing the admin screen asks for, so a project is never removed by a stray click.
// The server does a soft delete: the project leaves every list and the agent stops, but nothing is
// destroyed, so SuperRank can restore it. That is what the wording promises, and no more.
export default function DeleteProjectModal({ project, onClose, onDeleted }) {
  const [typed, setTyped] = useState('');
  const [state, setState] = useState('idle');
  const [error, setError] = useState(null);
  useEffect(() => { setTyped(''); setState('idle'); setError(null); }, [project?.id]);

  const matches = typed.trim() === project?.name;
  const remove = async (e) => {
    e?.preventDefault();
    if (!matches) return;
    setState('deleting'); setError(null);
    try {
      const result = await api.project.deleteProject(project.id, project.name);
      await onDeleted?.(project, result);
    } catch (err) {
      setError(err.message || 'Could not delete the project.');
      setState('error');
    }
  };

  return (
    <Modal isOpen={!!project} onClose={onClose} icon={Trash2} title="Delete project" maxWidth="max-w-[480px]"
      subtitle={<><span className="text-fg font-medium">{project?.name}</span>{project?.domain ? <> · {project.domain}</> : null}</>}
      footer={(
        <>
          <Button variant="light" onClick={onClose} disabled={state === 'deleting'}>Cancel</Button>
          <Button type="submit" form="delete-project-form" variant="primary" disabled={!matches || state === 'deleting'}
            style={{ background: '#b42318', boxShadow: 'none' }}>
            {state === 'deleting' ? 'Deleting…' : 'Delete project'}
          </Button>
        </>
      )}>
      <form id="delete-project-form" onSubmit={remove} className="space-y-4">
        <ul className="text-[13px] text-text space-y-1.5 pl-4" style={{ listStyle: 'disc' }}>
          <li>It disappears from your workspace, and everyone loses access to it.</li>
          <li>SuperRank's agent stops working on it, and its Google connection is removed.</li>
          <li>Nothing is erased straight away. If this was a mistake, SuperRank can restore it.</li>
        </ul>
        <Field label={<>Type <b className="font-semibold text-fg">{project?.name}</b> to confirm</>} value={typed}
          onChange={(e) => { setTyped(e.target.value); setError(null); }} placeholder={project?.name} autoFocus autoComplete="off" />
        {error && <div className="rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2" role="alert">{error}</div>}
      </form>
    </Modal>
  );
}
