import { useEffect, useState } from 'react';
import { Target } from 'lucide-react';
import Modal from '../Modal.jsx';
import Button from '../Button.jsx';
import GoalFields from './GoalFields.jsx';
import { DEFAULT_GOAL, goalComplete, goalsOf } from '../../lib/workspace.js';

// Set or change one project's goal. `saveGoal(goal)` is supplied by the caller
// (the workspace route for a workspace admin, the project route for a project admin).
export default function GoalModal({ project, saveGoal, onClose, onSaved }) {
  const [value, setValue] = useState(DEFAULT_GOAL);
  const [state, setState] = useState('idle');
  const [error, setError] = useState(null);
  // Start from what is saved: every goal that was ticked, and the words if one of them was
  // "Something else" (leaving them out used to wipe a custom goal's text on the next save).
  useEffect(() => {
    const g = project?.goal;
    setValue(g ? { goals: goalsOf(g), growth: g.growth, months: g.months, customText: g.customText || '' } : DEFAULT_GOAL);
    setError(null); setState('idle');
  }, [project]);

  const save = async () => {
    setState('saving'); setError(null);
    try { await saveGoal(value); await onSaved?.(); }
    catch (err) { setError(err.message || 'Could not save the goal.'); setState('error'); }
  };

  return (
    <Modal isOpen={!!project} onClose={onClose} icon={Target} title="What do you want to grow?" maxWidth="max-w-xl"
      subtitle={<>For <span className="text-fg font-medium">{project?.name}</span></>}
      footer={<><Button variant="light" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={state === 'saving' || !goalComplete(value)}>{state === 'saving' ? 'Saving…' : 'Save goal'}</Button></>}>
      <GoalFields value={value} onChange={setValue} />
      {error && <div className="rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2">{error}</div>}
    </Modal>
  );
}
