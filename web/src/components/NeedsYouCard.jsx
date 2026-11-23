import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import Button from './Button.jsx';

// The assistant's opening message when something is waiting on the person: what it is, how long it has waited, and the
// buttons to deal with it. Built from the server's real list (get_needs_you), no model call. "Approve all" uses the same
// bulk-approve the Action Center has and asks once first; every other button goes to the page where the item lives.
export default function NeedsYouCard({ items, onClose, onDone, siteId }) {
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
      const r = await api.actionCenter.bulkApproveDrafts(undefined, siteId);
      setResult(`Approved ${r?.approved ?? r?.shipped ?? 'the'} draft${(r?.approved ?? r?.shipped) === 1 ? '' : 's'}. I will tell you when they are on stage.`);
      onDone?.();
    } catch (e) {
      setResult(e.message || 'Could not approve right now. Try again in a moment.');
    } finally { setBusy(false); setConfirming(null); }
  };

  const [answering, setAnswering] = useState(null); // key of the decisions item opened in place

  const onAction = (item, a) => {
    if (a.id === 'approve_drafts') return setConfirming(item.key);
    if (a.id === 'answer_decisions') return setAnswering((k) => (k === 'decisions' ? null : 'decisions'));
    go(item.link);
  };

  const n = items.length;
  return (
    <div className="space-y-3 animate-fade-in">
      <p className="text-sm text-fg">{n === 1 ? 'One thing needs you:' : `${n} things need you:`}</p>
      {items.map((item) => (
        // The decisions card keeps one identity however many questions are left: its key lists the open question ids, so it changes
        // every time one is answered, and a changing key rebuilds the card (the open list collapses and "Saved" disappears).
        <div key={item.kind === 'decision' ? 'decisions' : item.key} className="rounded-[10px] px-3.5 py-3" style={{ boxShadow: '0 0 0 1px var(--border-canvas)' }}>
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
          ) : answering === 'decisions' && item.kind === 'decision' && item.decisions ? (
            <DecisionList decisions={item.decisions} onDone={onDone} onCollapse={() => setAnswering(null)} />
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

// Every open setup question in one place, answered without leaving the chat. "Use recommended" records the answer the
// repository evidence supports; "Skip it" records a no, and neither is asked again. Recording needs an admin on the
// project (confirm_decision's role); anyone else gets the plain reason instead of a broken button.
function DecisionList({ decisions, onDone, onCollapse }) {
  const [state, setState] = useState({}); // id -> 'saving' | 'done-yes' | 'done-no' | error text
  const [allConfirm, setAllConfirm] = useState(false);
  const [busyAll, setBusyAll] = useState(false);

  const record = async (d, accepted) => {
    setState((s) => ({ ...s, [d.id]: 'saving' }));
    try {
      const res = await api.assistant.invoke('confirm_decision', { findingId: d.id, accepted, chosen: accepted ? d.chosen : null });
      const failed = !res?.ok || res.data?.ok === false;
      const reason = res?.remedy || res?.data?.reason || 'Could not save that answer.';
      setState((s) => ({ ...s, [d.id]: failed ? reason : accepted ? 'done-yes' : 'done-no' }));
      return !failed;
    } catch (e) {
      const msg = e.status === 403
        ? 'Only an admin on this project can answer setup questions. Ask an admin on your team.'
        : (e.message || 'Could not save that answer.');
      setState((s) => ({ ...s, [d.id]: msg }));
      return false;
    }
  };

  const open = decisions.filter((d) => !String(state[d.id] || '').startsWith('done'));
  const withRec = open.filter((d) => d.recommendation);
  const acceptAll = async () => {
    setBusyAll(true);
    for (const d of withRec) await record(d, true); // one at a time: each is applied and validated on the server
    setBusyAll(false); setAllConfirm(false);
  };

  // Re-check what is waiting only once the person is finished (everything answered, or "Done for now"). Doing it after every single
  // answer re-sorts the card under them and loses the "Saved" confirmations.
  useEffect(() => { if (decisions.length && !open.length) onDone?.(); }, [open.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open.length) {
    return <p className="mt-2.5 text-[13px] text-text">All answered. I will not ask about these again.</p>;
  }

  return (
    <div className="mt-2.5 space-y-2">
      {withRec.length > 1 && (allConfirm ? (
        <div className="rounded-[8px] bg-muted px-3 py-2.5 text-[13px] text-fg">
          Use my recommended answer for all {withRec.length}?
          <div className="flex gap-1.5 mt-2">
            <Button size="sm" onClick={acceptAll} disabled={busyAll}>{busyAll ? 'Saving…' : 'Yes, use them'}</Button>
            <Button size="sm" variant="ghost" onClick={() => setAllConfirm(false)} disabled={busyAll}>Not yet</Button>
          </div>
        </div>
      ) : (
        <Button size="sm" onClick={() => setAllConfirm(true)}>Accept all {withRec.length} recommended</Button>
      ))}
      <div className="max-h-[260px] overflow-y-auto overscroll-contain space-y-2 p-px">
        {decisions.map((d) => {
          const st = state[d.id];
          const done = String(st || '').startsWith('done');
          const err = st && !done && st !== 'saving' ? st : null;
          return (
            <div key={d.id} className="rounded-[8px] px-3 py-2.5" style={{ boxShadow: '0 0 0 1px var(--border-canvas)' }}>
              <div className="text-[13px] font-medium text-fg [overflow-wrap:anywhere]">{d.subject}{d.ageDays >= 1 ? <span className="text-faint font-normal"> · {d.ageDays}d</span> : null}</div>
              {d.detail && <div className="text-xs text-faint mt-0.5 line-clamp-2">{d.detail}</div>}
              {done ? (
                <div className="text-xs mt-1.5" style={{ color: 'var(--green)' }}>{st === 'done-yes' ? `Saved${d.recommendation ? `: ${d.recommendation}` : ''}` : 'Skipped'}</div>
              ) : (
                <>
                  {d.recommendation
                    ? <div className="text-xs text-text mt-1">Recommended: <span className="font-medium text-fg">{d.recommendation}</span></div>
                    : <div className="text-xs text-text mt-1">No clear winner from the evidence. You can skip it, or ask me why.</div>}
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {d.recommendation && <Button size="sm" onClick={() => record(d, true)} disabled={st === 'saving' || busyAll}>Use “{d.recommendation}”</Button>}
                    <Button size="sm" variant="light" onClick={() => record(d, false)} disabled={st === 'saving' || busyAll}>Skip it</Button>
                  </div>
                  {err && <div className="text-xs mt-1.5" style={{ color: '#b42318' }}>{err}</div>}
                </>
              )}
            </div>
          );
        })}
      </div>
      <Button size="sm" variant="ghost" onClick={() => { onDone?.(); onCollapse(); }}>Done for now</Button>
    </div>
  );
}
