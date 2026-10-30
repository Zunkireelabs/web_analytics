import { useEffect, useState } from 'react';
import { Check, Info, Wand2, X } from 'lucide-react';
import { api } from '../api.js';
import Button from './Button.jsx';
import Badge from './Badge.jsx';
import OptionPreview from './content/OptionPreview.jsx';
import RealPreview from './content/RealPreview.jsx';
import ApproveBar from './ApproveBar.jsx';

// Fixes the agent could not fit into the client's design on its own. It tried (and checked every try at desktop, tablet
// and phone width), published nothing, and brings the choice here: what it tried, and a few options. One click on an
// option SELECTS it; one Approve button under the list approves everything selected. Only then is it saved, and the next
// scheduled run builds exactly that, checks it again, and opens the pull request, which a person still merges. Renders nothing when there is nothing to choose.
const pathOf = (url) => { try { return new URL(url).pathname || '/'; } catch { return url || ''; } };

export default function DesignChoices({ siteId }) {
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState(null);
  const [builtToday, setBuiltToday] = useState(false); // today's daily run already happened: new approvals wait for tomorrow's
  const [selected, setSelected] = useState({}); // chosen on screen but NOT approved yet: id -> optionKey
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    api.actionCenter.designChoices(siteId).then((r) => { if (alive) { setItems(r?.items || []); setBuiltToday(!!r?.builtToday); } }).catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [siteId]);

  // Selecting only marks the option on screen; clicking the selected one again un-selects it.
  const select = (item, optionKey) => {
    setError(null);
    setSelected((all) => { const next = { ...all }; if (next[item.id] === optionKey) delete next[item.id]; else next[item.id] = optionKey; return next; });
  };

  // The one Approve button: every selection is approved together, and only then saved.
  const approveAll = async () => {
    const choices = Object.entries(selected).map(([id, optionKey]) => ({ id: Number(id), optionKey }));
    if (!choices.length) return;
    setBusy('all'); setError(null);
    try {
      const r = await api.actionCenter.approveDesignChoices(choices, siteId);
      const byId = new Map((r.items || []).map((i) => [i.id, i]));
      setItems((all) => all.map((i) => (byId.has(i.id) ? { ...i, ...byId.get(i.id) } : i)));
      setSelected({});
    } catch (e) { setError(e.message || 'These could not be approved. Nothing was saved.'); } finally { setBusy(null); }
  };

  const takeBack = async (item) => {
    setBusy(item.id); setError(null);
    try { const next = await api.actionCenter.clearDesignChoice(item.id, siteId); setItems((all) => all.map((i) => (i.id === item.id ? { ...i, ...next } : i))); }
    catch (e) { setError(e.message || 'That could not be taken back.'); } finally { setBusy(null); }
  };

  if (!items || items.length === 0) return null;
  const waiting = items.filter((i) => (i.status === 'needs_choice' || i.status === 'withdrawn') && !selected[i.id]).length;
  const approvedCount = items.filter((i) => i.status === 'chosen').length;
  const selectedCount = Object.keys(selected).length;

  return (
    <section className="mb-6" aria-label="Needs your design choice">
      <div className="mb-2 px-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-semibold text-fg">Needs your design choice <span className="text-faint font-normal">· the agent could not fit these in without changing how your page looks</span></h2>
        <span className="text-xs text-faint">{waiting ? `${waiting} waiting for you` : selectedCount ? 'Selected. Approve below' : 'All approved. Built in the next run'}</span>
      </div>
      {error && <div className="mb-2 rounded-card bg-[#fdecec] text-[#b42318] text-sm px-4 py-3">{error}</div>}
      <div className="grid gap-3">
        {items.map((item) => {
          const chosen = item.status !== 'needs_choice' && item.status !== 'withdrawn' ? item.options.find((o) => o.key === item.chosen_option) : null;
          const selKey = selected[item.id] || null;
          const selOpt = item.options.find((o) => o.key === selKey);
          const locked = item.status === 'building';
          const variant = 'faq';
          return (
            <div key={item.id} className="tray"><div className="tray-card">
              <div className="px-4 py-3.5 flex flex-wrap items-start gap-3">
                <span className="w-8 h-8 rounded-control bg-primary-tint text-primary grid place-items-center shrink-0" style={{ boxShadow: 'inset 0 0 0 1px var(--primary-ring)' }}><Wand2 size={16} /></span>
                <div className="min-w-0 flex-1" style={{ minWidth: 240 }}>
                  <div className="flex items-center gap-2 flex-wrap"><h3 className="text-[15px] font-semibold text-fg">{item.title}</h3>{item.page_url && <span className="text-xs text-faint">{pathOf(item.page_url)}</span>}</div>
                  <p className="text-[13px] leading-5 text-text mt-1 flex items-start gap-1.5"><Info size={14} className="shrink-0 mt-[3px] text-faint" />{item.reason || `The agent tried ${item.attempts.length} times to add this without changing how your page looks, and could not. Nothing was published and your site is unchanged.`}</p>
                </div>
                {selOpt ? <Badge tone="amber">Selected: {selOpt.name}. Not approved yet</Badge> : chosen ? <Badge tone="green">{item.status === 'building' ? 'Building now' : `Approved: ${chosen.name}. Builds in the next run`}</Badge> : <Badge tone="red">Needs your design choice</Badge>}
              </div>
              <div className="px-4 pb-4 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))' }}>
                {item.options.map((o, idx) => {
                  const isSel = selKey === o.key;
                  const isApproved = !selKey && chosen?.key === o.key;
                  const on = isSel || isApproved;
                  const letter = String.fromCharCode(65 + idx);
                  return (
                    <div key={o.key} className="rounded-[12px] bg-white overflow-hidden" style={{ boxShadow: `0 0 0 ${on ? 2 : 1}px ${on ? 'var(--primary)' : 'var(--border-2)'}` }}>
                      <div className={`flex justify-center border-b border-border ${o.previewHtml ? '' : 'p-3'}`} style={{ background: '#faf9f7' }}>{o.previewHtml ? <RealPreview html={o.previewHtml} title={o.name} /> : <OptionPreview type="block" variant={variant} optionKey={letter} shape={o.shape} />}</div>
                      <div className="px-3.5 pt-3 pb-3.5">
                        <div className="flex items-center gap-2 flex-wrap"><span className="text-[11px] font-semibold tracking-[.06em] uppercase text-faint">Option {letter}</span>{o.tag && <Badge tone="amber">{o.tag}</Badge>}</div>
                        <div className="text-sm font-semibold text-fg mt-0.5">{o.name}</div>
                        <p className="text-[13px] leading-5 text-text mt-1" style={{ minHeight: 40 }}>{o.note}</p>
                        <div className="mt-2.5"><Button variant={on ? 'light' : 'primary'} onClick={() => select(item, o.key)} disabled={busy === item.id || busy === 'all' || locked}>{isSel ? <><Check size={14} />Selected</> : isApproved ? <><Check size={14} />Approved</> : 'Select this design'}</Button>
                        {isApproved && item.status === 'chosen' && <button type="button" className="ml-3 text-[13px] text-text underline underline-offset-2 hover:text-fg" onClick={() => takeBack(item)} disabled={busy === item.id}>Take back approval</button>}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {item.attempts.length > 0 && (
                <details className="px-4 pb-3.5 text-[13px]">
                  <summary className="cursor-pointer text-text hover:text-fg">What the agent tried ({item.attempts.length})</summary>
                  <ol className="mt-2 grid gap-1.5">
                    {item.attempts.map((a, i) => (
                      <li key={i} className="flex items-start gap-2.5"><span className="text-faint tnum w-4 shrink-0">{i + 1}</span><span className="min-w-0 flex-1"><span className="text-fg">{a.what}</span><span className="block text-xs text-faint">{a.result}</span></span><X size={14} className="shrink-0 mt-0.5" style={{ color: '#b42318' }} /></li>
                    ))}
                  </ol>
                </details>
              )}
            </div></div>
          );
        })}
      </div>
      <ApproveBar builtToday={builtToday} selected={selectedCount} approved={approvedCount} busy={busy === 'all'} onApprove={approveAll} onClear={() => setSelected({})} noun="design choice" />
    </section>
  );
}
