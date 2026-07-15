import { useLayoutEffect, useRef, useState } from 'react';
import { timeAgo } from '../api.js';
import { 
  PlusCircle, 
  CheckCircle2, 
  TrendingUp, 
  TrendingDown, 
  Activity,
  ArrowRight
} from 'lucide-react';

const MARKER = {
  health: {
    up: { icon: TrendingUp, color: '#10b981', bg: '#ecfdf5', border: '#a7f3d0' },
    down: { icon: TrendingDown, color: '#f43f5e', bg: '#fff1f2', border: '#fecdd3' }
  },
  resolved: { icon: CheckCircle2, color: '#10b981', bg: '#ecfdf5', border: '#a7f3d0' },
  new: { icon: PlusCircle, color: '#f43f5e', bg: '#fff1f2', border: '#fecdd3' },
  fallback: { icon: Activity, color: '#64748b', bg: '#f8fafc', border: '#e2e8f0' }
};

const PREFIX = { health: '', resolved: 'Resolved: ', new: 'New: ' };
const FALLBACK_COLLAPSED_HEIGHT = 480;

function highlightUrlsAndPaths(text) {
  // Regex to match URLs in double quotes or parens, or general http/https endpoints
  const parts = text.split(/("[^"]+"|\([^)]+\))/g);
  return parts.map((part, i) => {
    if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith('(') && part.endsWith(')'))) {
      const inner = part.slice(1, -1);
      if (inner.startsWith('http://') || inner.startsWith('https://')) {
        try {
          const url = new URL(inner);
          const displayPath = url.pathname + url.search;
          return (
            <span 
              key={i} 
              className="inline-block px-1.5 py-0.5 mx-0.5 text-[9px] font-mono font-bold bg-slate-100 text-slate-700 rounded-md border border-slate-200 truncate max-w-[180px] align-middle hover:max-w-none transition-all duration-300"
              title={inner}
            >
              {displayPath}
            </span>
          );
        } catch {
          return (
            <code key={i} className="px-1 py-0.5 mx-0.5 text-[9px] font-mono bg-slate-100 text-slate-700 rounded border border-slate-250 align-middle">
              {inner}
            </code>
          );
        }
      }
      return (
        <code key={i} className="px-1 py-0.5 mx-0.5 text-[9px] font-mono bg-slate-100 text-slate-700 rounded border border-slate-250 align-middle">
          {part}
        </code>
      );
    }
    return part;
  });
}

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
    return <div className="card p-6 text-center text-xs font-semibold text-slate-400">No changes logged since the last analysis.</div>;
  }

  return (
    <div className="relative pl-6 space-y-4">
      {/* Vertical Timeline Bar */}
      <div className="absolute left-[13px] top-2 bottom-2 w-[1.5px] bg-slate-100/80" />

      <div className="relative">
        <div 
          ref={contentRef} 
          className="space-y-4 overflow-hidden transition-[max-height] duration-300 ease-in-out"
          style={{ maxHeight: expanded ? 4000 : collapsedHeight }}
        >
          {items.map((c, i) => {
            const isHealth = c.type === 'health';
            const m = isHealth ? MARKER.health[c.positive ? 'up' : 'down'] : MARKER[c.type] || MARKER.fallback;
            const IconComponent = m.icon;
            const isNew = c.type === 'new';

            return (
              <div key={i} className="relative flex items-start gap-3.5 group">
                
                {/* Timeline Dot Indicator */}
                <span 
                  className="w-7 h-7 rounded-full grid place-items-center shrink-0 border z-10 bg-white transition shadow-sm group-hover:scale-105"
                  style={{ borderColor: m.border, color: m.color, backgroundColor: m.bg }}
                >
                  <IconComponent size={11} strokeWidth={2.5} />
                </span>

                {/* Content block */}
                <div className={`flex-1 min-w-0 border rounded-2xl p-3 transition ${
                  isNew ? 'bg-rose-500/[0.01] border-rose-500/10 hover:bg-rose-500/[0.03]' : 'bg-slate-50/40 border-slate-100 hover:bg-slate-50'
                }`}>
                  <div className="flex items-center justify-between gap-2 mb-1.5 flex-wrap">
                    <div className="flex items-center gap-1.5">
                      <span className={`text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full border ${
                        isNew ? 'text-rose-700 bg-rose-50 border-rose-100' : 'text-emerald-700 bg-emerald-50 border-emerald-100'
                      }`}>
                        {PREFIX[c.type]?.replace(': ', '') || 'Audit Update'}
                      </span>
                      {isNew && c.priority === 'high' && (
                        <span className="text-[8px] font-black tracking-widest text-white bg-rose-600 px-1.5 py-0.5 rounded-md animate-pulse">
                          CRITICAL
                        </span>
                      )}
                    </div>

                    <span className="text-[10px] text-slate-400 font-mono font-medium">
                      {timeAgo(c.at)}
                    </span>
                  </div>

                  <p className="text-[11.5px] font-semibold text-slate-700 leading-relaxed break-words">
                    {highlightUrlsAndPaths(c.text)}
                  </p>
                </div>

              </div>
            );
          })}
        </div>

        {!expanded && overflowing && (
          <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-white to-transparent pointer-events-none" />
        )}
      </div>

      {overflowing && (
        <div className="pt-2">
          <button 
            type="button" 
            onClick={() => setExpanded(!expanded)}
            className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-[#6C63FF] hover:underline hover:text-indigo-750 focus:outline-none"
          >
            {expanded ? 'Show fewer ↑' : `Show all ${items.length} updates →`}
          </button>
        </div>
      )}
    </div>
  );
}
