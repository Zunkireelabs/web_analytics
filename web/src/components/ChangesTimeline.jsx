import { useLayoutEffect, useRef, useState } from 'react';
import { timeAgo } from '../api.js';

const MARKER = {
  health: { up: { icon: '↑', color: '#10b981' }, down: { icon: '↓', color: '#e11d48' } },
  resolved: { icon: '✓', color: '#10b981' },
  new: { icon: '●', color: '#e11d48' },
};
const PREFIX = { health: '', resolved: 'Resolved: ', new: 'New: ' };
const FALLBACK_COLLAPSED_HEIGHT = 480; // used only before AI Activity's real height is measured

// New-vs-resolved since the last analysis run (diffed server-side by finding
// id — see agents/lib/command-center.js's getRecentChanges), plus one
// week-over-week health delta entry when available. Reinforces continuous
// work: things get fixed between visits, not just discovered. "New" rows
// get a light rose wash — they're the ones still needing attention;
// "resolved" rows stay plain white, already closed out.
//
// `matchHeight` (CommandCenter.jsx, measured off the AI Activity card next
// to this one) clamps this card to the same visual height even though its
// rows (canonical-mismatch URLs, etc.) run much longer than Activity's
// one-liners — overflow collapses behind a fade + "Show all" toggle instead
// of the two cards drifting to mismatched heights at equal item counts.
export default function ChangesTimeline({ items, matchHeight }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const contentRef = useRef(null);
  const collapsedHeight = matchHeight || FALLBACK_COLLAPSED_HEIGHT;

  useLayoutEffect(() => {
    if (!contentRef.current) return;
    setOverflowing(contentRef.current.scrollHeight > collapsedHeight + 1);
  }, [items, collapsedHeight]);

  if (!items?.length) {
    return <div className="card p-6 text-center text-sm text-slate-400">No changes since the last analysis.</div>;
  }

  return (
    <div className="card overflow-hidden">
      <div className="relative">
        <div ref={contentRef} className="divide-y divide-slate-50 overflow-hidden transition-[max-height] duration-300 ease-in-out"
          style={{ maxHeight: expanded ? 4000 : collapsedHeight }}>
          {items.map((c, i) => {
            const m = c.type === 'health' ? MARKER.health[c.positive ? 'up' : 'down'] : MARKER[c.type] || MARKER.new;
            const isNew = c.type === 'new';
            return (
              <div key={i} className={`flex items-start gap-3 px-4 py-3 ${isNew ? 'bg-rose-50/40' : ''}`}>
                <span className="mt-0.5 w-7 h-7 rounded-lg grid place-items-center text-[12px] font-bold shrink-0"
                  style={{ background: `${m.color}1a`, color: m.color }}>
                  {m.icon}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-slate-700 leading-snug">
                    <span className="font-semibold" style={{ color: isNew ? m.color : undefined }}>{PREFIX[c.type] ?? ''}</span>
                    {c.text}
                    {isNew && c.priority === 'high' && <span className="ml-1.5 text-[10px] font-bold text-rose-600">HIGH</span>}
                  </p>
                  <p className="text-[11px] text-slate-400 mt-0.5">{timeAgo(c.at)}</p>
                </div>
              </div>
            );
          })}
        </div>
        {!expanded && overflowing && (
          <div className="absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-white to-transparent pointer-events-none" />
        )}
      </div>
      {overflowing && (
        <button type="button" onClick={() => setExpanded((e) => !e)}
          className="w-full text-xs font-semibold text-indigo-600 hover:bg-indigo-50/60 px-4 py-2.5 border-t border-slate-50 transition">
          {expanded ? 'Show fewer ↑' : `Show all ${items.length} →`}
        </button>
      )}
    </div>
  );
}
