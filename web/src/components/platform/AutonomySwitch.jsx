import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api } from '../../api.js';
import Button from '../Button.jsx';
import Modal from '../Modal.jsx';

// The per-project Auto-fixes switch. Turning it ON asks first (it lets the agent open pull requests on its own); turning it
// OFF is immediate. The server refuses to turn it on without a connected GitHub repository and says why, so a disabled
// switch here always carries the reason underneath it.
export function Switch({ on, disabled, onClick, label, title }) {
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled} onClick={onClick} title={title}
      className="inline-flex items-center gap-2.5 whitespace-nowrap text-[13px] font-medium text-fg disabled:text-faint disabled:cursor-not-allowed bg-transparent border-0 p-0">
      <i className={`relative w-[34px] h-5 rounded-full shrink-0 transition-colors ${on ? 'bg-[var(--green)]' : 'bg-[#d4d4d4]'} ${disabled ? 'opacity-55' : ''}`}>
        <i className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all" style={{ left: on ? 16 : 2, boxShadow: '0 1px 2px #0003' }} />
      </i>
      {label}
    </button>
  );
}

// Handles the whole flow for one project: `project` is { id, name, autonomy }. `onChanged(autonomy)` receives the server's answer.
export function useAutonomy(onChanged) {
  const [ask, setAsk] = useState(null); // the project waiting for the "turn on" confirmation
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = async (project, enabled) => {
    setBusy(true); setError(null);
    try { const out = await api.platform.setAutonomy(project.id, enabled); onChanged(project.id, out?.autonomy ?? out); setAsk(null); }
    catch (e) { setError(e?.message || 'Auto-fixes could not be changed.'); } finally { setBusy(false); }
  };
  const toggle = (project) => { setError(null); if (project.autonomy.enabled) set(project, false); else setAsk(project); };
  const dialog = (
    <Modal isOpen={Boolean(ask)} onClose={() => !busy && setAsk(null)} icon={ShieldCheck} maxWidth="max-w-[520px]"
      title={`Turn on autonomous fixes for ${ask?.name || 'this project'}?`} subtitle="Starts from the next daily run."
      footer={<><Button variant="light" onClick={() => setAsk(null)} disabled={busy}>Cancel</Button><Button variant="primary" onClick={() => set(ask, true)} disabled={busy}>{busy ? 'Turning on…' : 'Turn on'}</Button></>}>
      <div className="space-y-3 text-[13.5px] leading-5 text-text">
        <div><h4 className="text-[11px] font-semibold uppercase tracking-[.05em] text-faint mb-1">What happens</h4>
          <ul className="list-disc pl-5 space-y-1"><li>Safe fixes, such as titles, descriptions and schema, are opened as pull requests on the client&rsquo;s repository without waiting for approval.</li><li>Anything riskier still waits in the client&rsquo;s Action Center for a person to approve.</li></ul></div>
        <div><h4 className="text-[11px] font-semibold uppercase tracking-[.05em] text-faint mb-1">What does not happen</h4>
          <ul className="list-disc pl-5 space-y-1"><li>Nothing is merged or published by the agent. A person always merges.</li></ul></div>
        <p className="rounded-[10px] px-3 py-2.5 text-[13px]" style={{ background: '#fdf3e1', boxShadow: 'inset 0 0 0 1px #f1dcae', color: '#7a5b00' }}>Recorded with your name and the time. You can turn it off at any time; pull requests already opened stay open.</p>
        {error && <p className="text-[13px]" style={{ color: '#b42318' }} role="alert">{error}</p>}
      </div>
    </Modal>
  );
  return { toggle, dialog, busy, error, clearError: () => setError(null) };
}
