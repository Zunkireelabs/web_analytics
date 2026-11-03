import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import Button from '../Button.jsx';
import Modal from '../Modal.jsx';
import Select from '../Select.jsx';

// How many days each choice offers; the saved value is always added if it is not one of them.
const CHOICES = {
  remindAfterDays: [1, 2, 3, 5, 7, 10, 14, 21, 30],
  linkDays: [1, 2, 3, 5, 7, 14],
  keepDays: [7, 14, 30, 45, 60],
};

function Option({ title, hint, children }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 border-t border-border first:border-0 first:pt-0">
      <div className="min-w-0">
        <b className="block text-[13px] font-medium text-fg">{title}</b>
        <span className="block text-[12.5px] leading-[18px] text-faint mt-0.5">{hint}</span>
      </div>
      {children}
    </div>
  );
}

function Switch({ checked, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
      className={`relative w-10 h-[22px] rounded-full shrink-0 transition-colors ${checked ? 'bg-primary' : 'bg-[#d4d2ce]'}`}>
      <span className={`absolute top-[3px] size-4 rounded-full bg-white shadow transition-[left] ${checked ? 'left-[21px]' : 'left-[3px]'}`} />
    </button>
  );
}

function Days({ field, value, onChange, label }) {
  const list = [...new Set([...CHOICES[field], value])].sort((a, b) => a - b);
  return (
    <Select aria-label={label} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-[110px] shrink-0">
      {list.map((n) => <option key={n} value={n}>{n} {n === 1 ? 'day' : 'days'}</option>)}
    </Select>
  );
}

// "Automatic reminders": the settings of the one reminder email and of how long saved answers are kept.
export default function SignupRemindersModal({ isOpen, settings, onClose, onSaved }) {
  const [form, setForm] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { if (isOpen) { setForm(settings); setError(null); } }, [isOpen, settings]);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setBusy(true); setError(null);
    try { await api.platform.signupProgress.saveSettings(form); onSaved(); }
    catch (e) { setError(e.message || 'Could not save the settings.'); }
    finally { setBusy(false); }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Automatic reminders" subtitle="One email with a link back to exactly where they stopped." maxWidth="max-w-[500px]"
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" write disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button>
      </>}>
      <div>
        <Option title="Send reminders" hint="Turn off to pause every automatic email.">
          <Switch checked={form.enabled} onChange={set('enabled')} label="Send reminders" />
        </Option>
        <Option title="Send the reminder after" hint="Counted from the last time they answered.">
          <Days field="remindAfterDays" value={form.remindAfterDays} onChange={set('remindAfterDays')} label="Send the reminder after" />
        </Option>
        <Option title="The link works for" hint="After that, they sign in with a code instead.">
          <Days field="linkDays" value={form.linkDays} onChange={set('linkDays')} label="The link works for" />
        </Option>
        <Option title="Keep saved answers for" hint="Then a returning visitor starts fresh.">
          <Days field="keepDays" value={form.keepDays} onChange={set('keepDays')} label="Keep saved answers for" />
        </Option>
        <Option title="Only confirmed email addresses" hint="People who never typed their code are not emailed on our own. You can still send by hand.">
          <Switch checked={form.confirmedOnly} onChange={set('confirmedOnly')} label="Only confirmed email addresses" />
        </Option>
      </div>
      {error && <p className="rounded-control px-3 py-2 text-[13px] bg-[#fdecec] text-[#b42318]" role="alert">{error}</p>}
    </Modal>
  );
}
