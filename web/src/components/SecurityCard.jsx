import { useState } from 'react';
import { api } from '../api.js';
import { ShieldCheck, Lock, CheckCircle2 } from 'lucide-react';
import Modal from './Modal.jsx';

const inputCls = 'w-full text-base sm:text-xs border border-slate-200/80 rounded-xl px-3.5 py-2.5 bg-slate-50/50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#6C63FF]/10 focus:border-[#6C63FF] transition duration-150 font-medium text-slate-800 placeholder:text-slate-400';
const labelCls = 'block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5';

function Field({ label, hint, icon: Icon, ...props }) {
  return (
    <label className="block">
      <span className={labelCls}>{label}</span>
      <div className="relative">
        {Icon && (
          <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
            <Icon size={14} />
          </span>
        )}
        <input className={`${inputCls} ${Icon ? 'pl-10' : ''}`} {...props} />
      </div>
      {hint && <span className="block text-[9.5px] font-semibold text-slate-400 mt-1">{hint}</span>}
    </label>
  );
}

// A row of security actions. Only "Password" has real backend support today
// (api.changePassword) — this component is the extension point for future
// rows (2FA, recovery codes, active sessions) once those APIs exist; adding
// one is another <ActionRow> here, no layout rework needed.
function ActionRow({ icon: Icon, label, detail, action }) {
  return (
    <div className="flex items-center justify-between gap-3 border border-slate-100 rounded-xl px-3.5 py-3">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-8 h-8 rounded-lg bg-slate-50 border border-slate-100 grid place-items-center text-slate-400 shrink-0">
          <Icon size={14} />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-bold text-slate-800">{label}</p>
          {detail && <p className="text-[10px] font-semibold text-slate-400 mt-0.5 truncate">{detail}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

export default function SecurityCard() {
  const [modalOpen, setModalOpen] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [state, setState] = useState('idle');
  const [formError, setFormError] = useState(null);

  const closeModal = () => {
    setModalOpen(false);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setState('idle');
    setFormError(null);
  };

  const submit = async (e) => {
    e.preventDefault();
    setState('idle');
    setFormError(null);

    // Client-side checks mirror the server's own validation (defense in
    // depth, not the source of truth) — server/routes/login.js's
    // POST /change-password enforces the same 8-char minimum independently.
    if (newPassword.length < 8) {
      setFormError('New password must be at least 8 characters.');
      setState('error');
      return;
    }
    if (newPassword !== confirmPassword) {
      setFormError('New password and confirmation do not match.');
      setState('error');
      return;
    }

    setState('running');
    try {
      await api.changePassword(currentPassword, newPassword);
      setState('success');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setFormError(err.message || 'Could not change password.');
      setState('error');
    }
  };

  return (
    <div className="bg-white/70 border border-slate-200/50 backdrop-blur-md shadow-sm rounded-2xl p-6">
      <h2 className="text-sm font-black text-slate-900 mb-4 flex items-center gap-2">
        <ShieldCheck size={15} className="text-[#6C63FF]" /> Security
      </h2>

      <div className="space-y-2">
        <ActionRow
          icon={Lock}
          label="Password"
          detail="Change your account password."
          action={(
            <button type="button" onClick={() => setModalOpen(true)}
              className="shrink-0 text-[10px] font-black uppercase tracking-wider px-3.5 py-2 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-650 transition">
              Change
            </button>
          )}
        />
      </div>

      <Modal isOpen={modalOpen} onClose={closeModal} title="Change Password" subtitle="Requires your current password." icon={Lock}>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Current Password" type="password" value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)} placeholder="Current password" required icon={Lock} />
          <Field label="New Password" type="password" value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)} placeholder="At least 8 characters" required minLength={8} icon={Lock} />
          <Field label="Confirm New Password" type="password" value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Re-enter new password" required minLength={8} icon={Lock} />

          {state === 'error' && formError && (
            <div className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2">
              {formError}
            </div>
          )}
          {state === 'success' && (
            <div className="text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-xl px-3 py-2 flex items-center gap-2">
              <CheckCircle2 size={14} /> Password changed.
            </div>
          )}

          <button type="submit" disabled={state === 'running'}
            className="w-full text-[10px] font-black uppercase tracking-wider px-5 py-3 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] disabled:opacity-60 shadow-md shadow-indigo-500/10 hover:shadow-indigo-500/20"
            style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>
            {state === 'running' ? 'Changing Password…' : 'Change Password'}
          </button>
        </form>
      </Modal>
    </div>
  );
}
