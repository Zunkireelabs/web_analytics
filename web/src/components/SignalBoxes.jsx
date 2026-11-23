import { useState } from 'react';
import { STATUS } from '../lib/palette.js';

// The earlier Action Center design, back as boxes: one per signal family (SEO, AEO, GEO) with the issues behind it.
// Only real findings are shown (no made-up scores): the count, how many are critical, and the issues themselves.
const FAMILIES = [
  { key: 'seo', name: 'SEO signals', sub: 'Google search' },
  { key: 'aeo', name: 'AEO signals', sub: 'Quick answers and AI Overviews' },
  { key: 'geo', name: 'GEO signals', sub: 'ChatGPT, Perplexity and Gemini' },
];
const SEV = { high: STATUS.critical.color, medium: STATUS.warning.color, low: '#c9c9c9' };

const STATES = [
  { key: 'open', label: 'Open' },
  { key: 'progress', label: 'Being fixed' },
  { key: 'fixed', label: 'Fixed' },
];

// open / progress: recommendation items. fixed: shipped drafts (each carries its `bucket`). `only` limits the boxes to
// the family picked in the SEO / AEO / GEO chips.
export default function SignalBoxes({ items, inProgress = [], fixed = [], only = 'all', titleFor, draftTitleFor, onOpen, onOpenDraft, renderBadge }) {
  const [state, setState] = useState({});
  const groups = FAMILIES
    .filter((f) => only === 'all' || only === f.key)
    .map((f) => ({
      ...f,
      lists: {
        open: (items || []).filter((i) => i.bucket === f.key),
        progress: (inProgress || []).filter((i) => i.bucket === f.key),
        fixed: (fixed || []).filter((d) => d.bucket === f.key),
      },
    }))
    .filter((g) => g.lists.open.length + g.lists.progress.length + g.lists.fixed.length);
  if (!groups.length) return null;
  return (
    <section className="mt-6" aria-label="Signals">
      <div className="mb-2 px-1">
        <h2 className="text-[13px] font-semibold text-fg">Signals <span className="text-faint font-normal">· every fix by what it helps: Google, quick answers, AI chat</span></h2>
      </div>
      <div className={`grid gap-3 items-stretch ${groups.length > 1 ? 'lg:grid-cols-3' : ''}`}>
        {groups.map((g) => {
          const cur = state[g.key] || (g.lists.open.length ? 'open' : g.lists.progress.length ? 'progress' : 'fixed');
          const list = g.lists[cur];
          const critical = g.lists.open.filter((i) => i.priority === 'high').length;
          return (
            <div key={g.key} className="tray h-full"><div className="tray-card h-full flex flex-col">
              <div className="px-4 pt-3.5 pb-2.5 flex items-start justify-between gap-3">
                <div className="min-w-0"><h3 className="text-[15px] font-semibold tracking-[-0.01em] text-fg">{g.name}</h3><p className="text-xs text-faint mt-0.5">{g.sub}</p></div>
                <div className="text-right shrink-0"><div className="text-[22px] leading-7 font-semibold tracking-[-0.02em] text-fg tnum">{g.lists.fixed.length}<span className="text-[13px] text-faint font-normal"> fixed</span></div>
                  <div className="text-xs font-medium" style={{ color: critical ? STATUS.critical.text : 'var(--faint)' }}>{critical ? `${critical} critical open` : `${g.lists.open.length} open`}</div></div>
              </div>
              <div className="px-3 pb-2 flex gap-1.5" role="tablist">
                {STATES.map((st) => (
                  <button key={st.key} type="button" role="tab" aria-selected={cur === st.key} onClick={() => setState((s) => ({ ...s, [g.key]: st.key }))}
                    className="h-7 px-2.5 rounded-full text-[12px] font-medium" style={cur === st.key ? { background: 'var(--fg)', color: '#fff' } : { boxShadow: 'inset 0 0 0 1px var(--input)', color: 'var(--text)' }}>
                    {st.label} <span className="tnum opacity-70">{g.lists[st.key].length}</span>
                  </button>
                ))}
              </div>
              {/* Same as the cards above: the list scrolls inside a fixed height instead of growing the page. */}
              <div className="flex-1 min-h-0 max-h-[360px] overflow-y-auto overscroll-contain">
              {list.length === 0 && <div className="px-4 py-3 border-t border-border text-[13px] text-faint">Nothing here yet.</div>}
              {cur === 'fixed' ? list.map((d) => (
                <button key={d.id} type="button" onClick={() => onOpenDraft?.(d)} className="w-full text-left px-4 py-2.5 border-t border-border flex items-center gap-2.5 hover:bg-[#fafafa]">
                  <span className="w-4 h-4 rounded-full shrink-0 grid place-items-center text-[9px] font-extrabold" style={{ background: 'var(--green-tint, #e8f5ee)', color: '#1a7f4b' }}>✓</span>
                  <span className="min-w-0 flex-1 text-[13px] text-fg line-clamp-2 [overflow-wrap:anywhere]" title={draftTitleFor(d)}>{draftTitleFor(d)}</span>
                  {d.implemented_at && <span className="text-xs text-faint shrink-0">{new Date(d.implemented_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>}
                </button>
              )) : list.map((item) => (
                <button key={item.id} type="button" onClick={() => onOpen(item)} className="w-full text-left px-4 py-2.5 border-t border-border flex items-center gap-2.5 hover:bg-[#fafafa]">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: SEV[item.priority] || SEV.low }} />
                  <span className="min-w-0 flex-1 text-[13px] text-fg line-clamp-2 [overflow-wrap:anywhere]" title={titleFor(item)}>{titleFor(item)}</span>
                  {renderBadge(item)}
                </button>
              ))}
              </div>
            </div></div>
          );
        })}
      </div>
    </section>
  );
}
