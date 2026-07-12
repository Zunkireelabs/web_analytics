import { useState } from 'react';
import { CATEGORY } from './AgentCard.jsx';

// Read-only summary of an already-persisted agent run — no run button, no
// raw-facts dump. AI Growth is where the internal team runs agents; Reports
// is where clients consume the results.
export default function AgentFindingCard({ category, name, stat, headline, narrative }) {
  const [expanded, setExpanded] = useState(false);
  const cat = CATEGORY[category] || CATEGORY.seo;
  const hasMore = narrative && narrative !== headline;

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2.5">
        <span className="w-8 h-8 rounded-lg grid place-items-center text-sm shrink-0"
          style={{ background: `${cat.color}1a`, color: cat.color }}>{cat.icon}</span>
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-wide" style={{ color: cat.color }}>{cat.label}</div>
          {stat && <div className="text-xs text-slate-400 truncate">{stat}</div>}
        </div>
      </div>
      <p className="text-sm font-semibold text-slate-800 mt-2.5 leading-snug break-words">{headline}</p>
      {hasMore && (
        <>
          <button type="button" onClick={() => setExpanded((e) => !e)}
            className="text-[11px] font-semibold text-slate-400 hover:text-slate-600 mt-1.5">
            {expanded ? 'Show less ↑' : 'Read more →'}
          </button>
          {expanded && <p className="text-xs text-slate-500 leading-relaxed mt-1.5 break-words">{narrative}</p>}
        </>
      )}
    </div>
  );
}
