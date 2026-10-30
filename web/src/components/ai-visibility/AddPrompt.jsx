import { useState } from 'react';
import { Plus } from 'lucide-react';
import Button from '../Button.jsx';

export default function AddPrompt({ suggestions, onAdd }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function submit(value) {
    const v = value.trim();
    if (!v || busy) return;
    setBusy(true); setMsg(null);
    try {
      await onAdd(v);
      setText('');
      setMsg({ ok: true, text: 'Added. The agent checks it on its next run, then it shows up in the lists.' });
    } catch (e) {
      setMsg({ ok: false, text: e.message || 'Could not add that prompt.' });
    } finally { setBusy(false); }
  }

  return (
    <div className="tray">
      <div className="tray-card">
        <div className="px-4 pt-3.5 pb-2">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-fg">Add a prompt</h2>
          <p className="text-xs text-faint mt-0.5">Your own question, checked on every connected engine</p>
        </div>
        <form className="px-4 pb-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); submit(text); }}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={200}
            placeholder="What would a buyer ask?"
            aria-label="Prompt to track"
            className="flex-1 min-w-0 h-8 px-2.5 rounded-control text-[13px] outline-none"
            style={{ boxShadow: '0 0 0 1px var(--input), 0 1px 2px rgba(0,0,0,.03)' }}
          />
          <Button type="submit" size="sm" variant="primary" disabled={busy || text.trim().length < 8}><Plus size={13} />Add</Button>
        </form>
        {msg && <p className="px-4 pb-2 text-xs" style={{ color: msg.ok ? 'var(--text)' : '#b42318' }}>{msg.text}</p>}
        {suggestions.length > 0 && (
          <>
            <div className="px-4 pt-1 text-[11px] font-medium tracking-[.06em] uppercase text-faint">Suggested for you</div>
            <div className="px-4 pt-1.5 pb-3.5 flex flex-wrap gap-1.5">
              {suggestions.map((s) => (
                <button key={s} type="button" disabled={busy} onClick={() => submit(s)}
                  className="inline-flex items-center gap-1.5 h-[26px] px-2.5 rounded-[7px] text-[13px] bg-primary-tint text-primary disabled:opacity-60"
                  style={{ boxShadow: 'inset 0 0 0 1px var(--primary-ring)' }}>
                  <Plus size={11} />{s}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
