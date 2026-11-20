import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import Button from './Button.jsx';

// The assistant's opening message when something is waiting on the person: what it is, how long it has waited, and the
// buttons to deal with it. Built from the server's real list (get_needs_you), no model call. "Approve all" uses the same
// bulk-approve the Action Center has and asks once first; every other button goes to the page where the item lives.
export default function NeedsYouCard({ items, onClose, onDone }) {
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const go = (link) => {
    if (!link) return;
    onClose?.();
    if (/^https?:/.test(link)) window.open(link, '_blank', 'noopener');
    else navigate(link);
  };

  const approveAll = async () => {
    setBusy(true); setResult(null);
    try {
      const r = await api.actionCenter.bulkApproveDrafts();
      setResult(`Approved ${r?.approved ?? r?.shipped ?? 'the'} draft${(r?.approved ?? r?.shipped) === 1 ? '' : 's'}. I will tell you when they are on stage.`);
      onDone?.();
    } catch (e) {
      setResult(e.message || 'Could not approve right now. Try again in a moment.');
    } finally { setBusy(false); setConfirming(null); }
  };

  const onAction = (item, a) => {
    if (a.id === 'approve_drafts') return setConfirming(item.key);
    go(item.link);
  };

  const n = items.length;
  return (
    <div className="space-y-3 animate-fade-in">
      <p className="text-sm text-fg">{n === 1 ? 'One thing needs you:' : `${n} things need you:`}</p>
      {items.map((item) => (
        <div key={item.key} className="rounded-[10px] px-3.5 py-3" style={{ boxShadow: '0 0 0 1px var(--border-canvas)' }}>
          <div className="text-sm font-medium text-fg">{item.title}{item.ageDays >= 1 ? <span className="text-faint font-normal"> · {item.ageDays}d</span> : null}</div>
          {item.detail && <div className="text-xs text-faint mt-0.5">{item.detail}</div>}
          {confirming === item.key ? (
            <div className="mt-2.5 text-[13px] text-fg">
              Approve all {item.count} and open the pull request to stage?
              <div className="flex gap-1.5 mt-2">
                <Button size="sm" onClick={approveAll} disabled={busy}>{busy ? 'Approving…' : 'Yes, approve'}</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(null)} disabled={busy}>Not yet</Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5 mt-2.5">
              {(item.actions || []).map((a) => (
                <Button key={a.id} size="sm" variant={a.id === 'approve_drafts' ? 'primary' : 'light'} onClick={() => onAction(item, a)}>{a.label}</Button>
              ))}
            </div>
          )}
        </div>
      ))}
      {result && <p className="text-[13px] text-text">{result}</p>}
    </div>
  );
}
