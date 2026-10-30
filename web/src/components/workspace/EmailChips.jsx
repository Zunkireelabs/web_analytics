import { useState } from 'react';
import { X } from 'lucide-react';

const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

// Several email addresses in one field. Press Enter, comma or space (or leave the
// field) to turn what you typed into a chip; click × to remove one.
export default function EmailChips({ emails, onChange, placeholder = 'name@company.com', autoFocus = false }) {
  const [draft, setDraft] = useState('');
  const commit = (raw) => {
    const parts = raw.split(/[\s,;]+/).map((p) => p.trim().toLowerCase()).filter(Boolean);
    const fresh = parts.filter((p) => looksLikeEmail(p) && !emails.includes(p));
    if (fresh.length) onChange([...emails, ...fresh]);
    setDraft(parts.filter((p) => !looksLikeEmail(p)).join(' '));
  };
  return (
    <div className="min-h-[34px] flex flex-wrap items-center gap-1.5 px-2 py-1 rounded-control bg-white"
      style={{ boxShadow: '0 0 0 1px var(--input), 0 1px 2px rgba(0,0,0,.03)' }}>
      {emails.map((e) => (
        <span key={e} className="badge badge--grey" style={{ borderRadius: 6 }}>
          {e}
          <button type="button" aria-label={`Remove ${e}`} className="text-faint hover:text-fg" onClick={() => onChange(emails.filter((x) => x !== e))}>
            <X size={11} />
          </button>
        </span>
      ))}
      <input type="text" value={draft} autoFocus={autoFocus} aria-label="Email addresses"
        placeholder={emails.length ? 'Add another email…' : placeholder}
        onChange={(ev) => (/[\s,;]$/.test(ev.target.value) ? commit(ev.target.value) : setDraft(ev.target.value))}
        onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); commit(draft); } else if (ev.key === 'Backspace' && !draft && emails.length) onChange(emails.slice(0, -1)); }}
        onBlur={() => draft && commit(draft)}
        className="flex-1 min-w-[140px] bg-transparent outline-none text-[13px] text-fg placeholder:text-faint py-1 px-1" />
    </div>
  );
}
