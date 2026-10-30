import { useState } from 'react';
import { api } from '../api.js';
import { Lock, CheckCircle2 } from 'lucide-react';
import Field from './Field.jsx';
import Button from './Button.jsx';
import SettingsCard from './settings/SettingsCard.jsx';

export default function SecurityCard() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [state, setState] = useState('idle');
  const [formError, setFormError] = useState(null);

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

  // Future security rows (2FA, recovery codes, active sessions) are more
  // SettingsCards stacked here once those APIs exist.
  return (
    <form onSubmit={submit}>
      <SettingsCard icon={Lock} title="Password" description="Requires your current password"
        footer={(
          <Button type="submit" variant="dark" disabled={state === 'running'}>
            {state === 'running' ? 'Changing password…' : 'Change password'}
          </Button>
        )}>
        <div className="px-5 py-4">
          <div className="grid gap-3.5 md:grid-cols-3">
            <Field label="Current password" type="password" value={currentPassword} autoComplete="current-password"
              onChange={(e) => setCurrentPassword(e.target.value)} placeholder="Current password" required />
            <Field label="New password" type="password" value={newPassword} autoComplete="new-password"
              onChange={(e) => setNewPassword(e.target.value)} placeholder="At least 8 characters" required minLength={8} />
            <Field label="Confirm new password" type="password" value={confirmPassword} autoComplete="new-password"
              onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Re-enter new password" required minLength={8} />
          </div>

          {state === 'error' && formError && (
            <div className="mt-3.5 rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2">
              {formError}
            </div>
          )}
          {state === 'success' && (
            <div className="mt-3.5 rounded-control bg-green-tint text-green text-[13px] px-3 py-2 flex items-center gap-2">
              <CheckCircle2 size={14} /> Password changed.
            </div>
          )}
        </div>
      </SettingsCard>
    </form>
  );
}
