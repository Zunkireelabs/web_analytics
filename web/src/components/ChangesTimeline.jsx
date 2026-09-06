import { timeAgo } from '../api.js';
import { 
  PlusCircle, 
  CheckCircle2, 
  TrendingUp, 
  TrendingDown, 
  Activity,
  Link2,
  Database,
  Sparkles
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

function pagePath(page) {
  try {
    const url = new URL(page);
    return url.pathname + url.search;
  } catch {
    return page;
  }
}

function parseTextStructure(text) {
  const parensMatches = [...text.matchAll(/\(([^)]+)\)/g)].map(m => m[1]);
  const quotesMatches = [...text.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  
  let cleanText = text;
  const paths = [];
  const contexts = [];
  const titles = [];
  
  parensMatches.forEach(match => {
    if (match.startsWith('/') || match.startsWith('http://') || match.startsWith('https://')) {
      paths.push(match);
    } else {
      contexts.push(match);
    }
    cleanText = cleanText.replace(`(${match})`, '');
  });
  
  quotesMatches.forEach(match => {
    if (match.startsWith('/') || match.startsWith('http://') || match.startsWith('https://')) {
      paths.push(match);
    } else if (match.length > 15) {
      titles.push(match);
    }
    cleanText = cleanText.replace(`"${match}"`, '');
  });
  
  // Clean up formatting
  cleanText = cleanText.replace(/\s+/g, ' ').replace(/\(\s*\)/g, '').replace(/""/g, '').trim();
  if (cleanText.endsWith('.')) cleanText = cleanText.slice(0, -1);
  
  return { cleanText, paths, contexts, titles };
}

export default function ChangesTimeline({ items }) {
  if (!items?.length) {
    return <div className="card p-6 text-center text-xs font-semibold text-slate-400">No changes logged since the last analysis.</div>;
  }

  return (
    <div className="relative pl-10 pr-4 space-y-4">
      {/* Vertical Timeline Bar */}
      <div className="absolute left-[8px] top-2 bottom-2 w-[1.5px] bg-slate-100/80" />

      <div className="space-y-4">
        {items.map((c, i) => {
          const isHealth = c.type === 'health';
          const m = isHealth ? MARKER.health[c.positive ? 'up' : 'down'] : MARKER[c.type] || MARKER.fallback;
          const IconComponent = m.icon;
          const isNew = c.type === 'new';
          const parsed = parseTextStructure(c.text);

          return (
            <div key={i} className="relative group">
              {/* Timeline Dot Indicator */}
              <span 
                className="absolute left-[-32px] top-[26px] -translate-x-1/2 -translate-y-1/2 w-7 h-7 rounded-full grid place-items-center border z-10 bg-white transition-all duration-300 shadow-sm group-hover:scale-110 group-hover:shadow-md"
                style={{ borderColor: m.border, color: m.color, backgroundColor: m.bg, boxShadow: `0 0 10px ${m.color}15` }}
              >
                <IconComponent size={11} strokeWidth={2.5} />
              </span>

              {/* Content block */}
              <div className={`border rounded-2xl p-4 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md hover:bg-white ${
                isNew 
                  ? 'bg-gradient-to-br from-white to-rose-500/[0.02] border-rose-500/20 hover:border-rose-500/40' 
                  : 'bg-gradient-to-br from-white to-slate-50/50 border-slate-200/80 hover:border-slate-300'
              }`}>
                <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-[9px] font-black uppercase tracking-wider px-2.5 py-0.5 rounded-full border shadow-sm ${
                      isNew ? 'text-rose-700 bg-rose-50 border-rose-100' : 'text-emerald-700 bg-emerald-50 border-emerald-100'
                    }`}>
                      {PREFIX[c.type]?.replace(': ', '') || 'Audit Update'}
                    </span>
                    {isNew && c.priority === 'high' && (
                      <span className="text-[8px] font-black tracking-widest text-white bg-rose-600 px-1.5 py-0.5 rounded-md animate-pulse shadow-sm shadow-rose-500/20">
                        CRITICAL
                      </span>
                    )}
                  </div>

                  <span className="text-[10px] text-slate-400 font-mono font-bold">
                    {timeAgo(c.at)}
                  </span>
                </div>

                <p className="text-[12px] font-extrabold text-slate-800 leading-relaxed break-words mb-2.5">
                  {parsed.cleanText}
                </p>

                {/* Structured pill targets */}
                {(parsed.paths.length > 0 || parsed.contexts.length > 0 || parsed.titles.length > 0) && (
                  <div className="border-t border-slate-100 mt-2.5 pt-2.5 flex flex-wrap gap-2">
                    {parsed.paths.map((p, idx) => (
                      <div key={idx} className="flex items-center gap-1.5 text-[9.5px] font-mono font-bold text-indigo-700 bg-indigo-50/50 border border-indigo-150/70 rounded-lg px-2.5 py-1 max-w-full truncate shadow-sm hover:bg-indigo-100/50 transition-colors">
                        <Link2 size={10} className="shrink-0 text-indigo-400" />
                        <span className="truncate" title={p}>{pagePath(p)}</span>
                      </div>
                    ))}

                    {parsed.contexts.map((ctx, idx) => (
                      <div key={idx} className="flex items-center gap-1.5 text-[9.5px] text-slate-650 bg-slate-50 border border-slate-200/60 rounded-lg px-2.5 py-1 max-w-full font-bold shadow-sm">
                        <Database size={10} className="shrink-0 text-slate-400" />
                        <span>{ctx}</span>
                      </div>
                    ))}

                    {parsed.titles.map((t, idx) => (
                      <div key={idx} className="flex items-center gap-1.5 text-[9.5px] text-violet-750 bg-violet-50/50 border border-violet-100/60 rounded-lg px-2.5 py-1 max-w-full font-black italic shadow-sm">
                        <Sparkles size={10} className="shrink-0 text-violet-400 animate-pulse" />
                        <span className="truncate">"{t}"</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

            </div>
          );
        })}
      </div>
    </div>
  );
}
