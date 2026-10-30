import { useState } from 'react';
import { UserPlus, Info, Check } from 'lucide-react';
import { api } from '../../api.js';
import Modal from '../Modal.jsx';
import Button from '../Button.jsx';
import EmailChips from './EmailChips.jsx';
import PermissionCards from './PermissionCards.jsx';
import ChoiceCard from './ChoiceCard.jsx';
import { siteInitials } from '../../lib/nav.js';
import { isWorkspaceOwner, plural } from '../../lib/workspace.js';

// "Give access", the way Search Console's Add user works: type one or more
// emails, pick where they can go and what they can do, done.
//
//   Whole workspace      every project in it, now and later
//   Only certain projects  just the ones ticked; nothing else in the workspace is visible
//
// Someone with an account is added at once; everyone else gets an email invitation.
// `onlyProject` is the project admin's version: no choice of where, their project only.
export default function GiveAccessModal({ workspace, onlyProject, actorRole, isOpen, onClose, onDone }) {
  const projects = workspace?.projects || [];
  const [emails, setEmails] = useState([]);
  const [scope, setScope] = useState('workspace'); // 'workspace' | 'projects'
  const [picked, setPicked] = useState([]);
  const [role, setRole] = useState('member');
  const [state, setState] = useState('idle');
  const [errors, setErrors] = useState([]);
  const scoped = !!onlyProject || scope === 'projects';

  const close = () => { setEmails([]); setScope('workspace'); setPicked([]); setRole('member'); setState('idle'); setErrors([]); onClose(); };
  const toggle = (id) => setPicked((ps) => (ps.includes(id) ? ps.filter((x) => x !== id) : [...ps, id]));
  const chooseScope = (next) => { setScope(next); if (next === 'projects' && role === 'owner') setRole('member'); };
  const ready = emails.length > 0 && (onlyProject || scope === 'workspace' || picked.length > 0);

  const send = (email) => (onlyProject
    ? api.project.invite(onlyProject.id, { email, role })
    : api.workspace.invite(workspace.id, { email, role, ...(scope === 'projects' ? { projectIds: picked } : {}) }));

  const submit = async () => {
    setState('saving'); setErrors([]);
    const failed = [];
    for (const email of emails) {
      try { await send(email); } catch (err) { failed.push(`${email}: ${err.message || 'could not be added.'}`); }
    }
    setErrors(failed);
    if (failed.length < emails.length) await onDone?.();
    if (failed.length === 0) close(); else { setEmails((es) => es.filter((e) => failed.some((f) => f.startsWith(`${e}:`)))); setState('error'); }
  };

  const target = onlyProject ? onlyProject.name : workspace?.name;
  return (
    <Modal isOpen={isOpen} onClose={close} icon={UserPlus} title="Give access" maxWidth="max-w-[520px]"
      subtitle={<>to <span className="text-fg font-medium">{target}</span></>}
      footer={<><Button variant="light" onClick={close}>Cancel</Button>
        <Button variant="primary" onClick={submit} disabled={!ready || state === 'saving'}><UserPlus size={14} />{state === 'saving' ? 'Giving access…' : 'Give access'}</Button></>}>
      <div>
        <div className="text-[13px] font-medium text-fg mb-1.5">Email addresses</div>
        <EmailChips emails={emails} onChange={setEmails} placeholder="name@company.com" autoFocus />
        <div className="fld__hint mt-1.5">Separate several addresses with a comma.</div>
      </div>

      {onlyProject ? (
        <div className="flex items-center gap-2 text-[13px] text-text">
          <span className="w-[22px] h-[22px] bg-primary text-white text-[9px] font-medium grid place-items-center" style={{ borderRadius: 7 }}>{siteInitials(onlyProject.name)}</span>
          <span>They get access to <b className="font-medium text-fg">{onlyProject.name}</b> only.</span>
        </div>
      ) : (
        <div>
          <div className="text-[13px] font-medium text-fg mb-2">Where can they go?</div>
          <div role="radiogroup" aria-label="Where can they go?" className="space-y-2">
            <ChoiceCard selected={scope === 'workspace'} onSelect={() => chooseScope('workspace')} title="The whole workspace"
              description={`All ${plural(projects.length, 'project', 'projects')} in ${workspace?.name}, including ones you add later.`} />
            <ChoiceCard selected={scope === 'projects'} onSelect={() => chooseScope('projects')} title="Only certain projects"
              description="Pick the projects they can open. They will not see anything else.">
              {scope === 'projects' && (
                <span className="block mt-2.5 space-y-1.5" onClick={(e) => e.stopPropagation()}>
                  {projects.map((p) => {
                    const on = picked.includes(p.id);
                    return (
                      <span key={p.id} role="checkbox" aria-checked={on} tabIndex={0} onClick={(e) => { e.stopPropagation(); toggle(p.id); }}
                        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(p.id); } }}
                        className="flex items-center gap-2 text-[13px] text-fg cursor-pointer">
                        <span className="w-4 h-4 shrink-0 grid place-items-center" style={{ borderRadius: 4, ...(on ? { background: 'var(--primary)', color: '#fff' } : { boxShadow: '0 0 0 1px var(--input)' }) }}>{on && <Check size={11} strokeWidth={2.5} />}</span>
                        <span className="w-[18px] h-[18px] bg-primary text-white text-[8px] font-medium grid place-items-center" style={{ borderRadius: 5 }}>{siteInitials(p.name)}</span>
                        {p.name}
                      </span>
                    );
                  })}
                </span>
              )}
            </ChoiceCard>
          </div>
        </div>
      )}

      <div>
        <div className="text-[13px] font-medium text-fg mb-2">What can they do?</div>
        <PermissionCards value={role} onChange={setRole} withOwner={isWorkspaceOwner(actorRole)} scoped={scoped} />
      </div>

      {errors.length > 0 && <div className="rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2 space-y-0.5">{errors.map((e) => <div key={e}>{e}</div>)}</div>}
      <div className="flex items-start gap-2.5 rounded-control bg-muted px-3 py-2.5 text-[13px] leading-5 text-text">
        <Info size={15} className="text-faint shrink-0 mt-0.5" />
        <span>{scoped
          ? 'They sign in with their email and password. They see only the projects above, under “Shared with you”, and nothing else in this workspace. If they have no account yet, we email them a link to set a password.'
          : 'They get an email with a link. If they already have an account, they get access straight away. You can change or remove access any time.'}</span>
      </div>
    </Modal>
  );
}
