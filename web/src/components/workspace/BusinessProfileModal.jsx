import { useEffect, useState } from 'react';
import { MapPin } from 'lucide-react';
import { api } from '../../api.js';
import Modal from '../Modal.jsx';
import Button from '../Button.jsx';
import BusinessProfileFields, { gbpReady, gbpSource } from './BusinessProfileFields.jsx';

// Change a project's Business Profile answer after setup (Project settings → General).
export default function BusinessProfileModal({ project, onClose, onSaved }) {
  const [choice, setChoice] = useState(null);
  const [url, setUrl] = useState('');
  const [state, setState] = useState('idle');
  const [error, setError] = useState(null);
  useEffect(() => {
    setChoice(project?.businessProfile?.status || null);
    setUrl(project?.businessProfile?.url || '');
    setError(null); setState('idle');
  }, [project]);

  const save = async () => {
    setState('saving'); setError(null);
    try {
      await api.project.connect.businessProfile(project.id, { status: choice, ...(choice === 'linked' ? { url } : {}) });
      await onSaved?.();
    } catch (err) { setError(err.message || 'Could not save your Business Profile.'); setState('error'); }
  };

  return (
    <Modal isOpen={!!project} onClose={onClose} icon={MapPin} title="Your Business Profile" maxWidth="max-w-xl"
      subtitle={<>For <span className="text-fg font-medium">{project?.name}</span></>}
      footer={<><Button variant="light" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={state === 'saving' || !gbpReady(choice, url)}>{state === 'saving' ? 'Saving…' : 'Save'}</Button></>}>
      <BusinessProfileFields choice={choice} setChoice={setChoice} url={url} setUrl={setUrl} source={project?.id ? gbpSource(project.id) : null} />
      {error && <div className="rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2">{error}</div>}
    </Modal>
  );
}
