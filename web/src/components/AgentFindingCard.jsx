import { useState } from 'react';
import { CATEGORY } from './AgentCard.jsx';

// Read-only summary of an already-persisted agent run — no run button, no
// raw-facts dump. AI Growth is where the internal team runs agents; Reports
// is where clients consume the results. Colored top accent + icon chip use
// the same category-color language as AgentCard/RecommendationCard, so a
// reader can tell SEO/Geo/Content/Executive apart at a glance across the
// whole Reports page, not just by reading the small label text.
export default function AgentFindingCard({ category, name, stat, headline, narrative }) {
  const [expanded, setExpanded] = useState(false);
  const cat = CATEGORY[category] || CATEGORY.seo;
  const hasMore = narrative && narrative !== headline;

  return (
    <div className="rounded-2xl border border-slate-100 bg-white overflow-hidden transition hover:border-slate-200 hover:shadow-[0_4px_16px_-4px_rgba(15,23,42,0.08)] flex flex-col">
      <div className="h-[3px] shrink-0" style={{ background: `linear-gradient(90deg, ${cat.color}, ${cat.color}55)` }} />
      <div className="p-4 flex flex-col flex-1">
        <div className="flex items-center gap-2.5">
          <span className="w-9 h-9 rounded-xl grid place-items-center text-base shrink-0"
            style={{ background: `${cat.color}14`, color: cat.color }}>{cat.icon}</span>
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-wide" style={{ color: cat.color }}>{cat.label}</div>
            {stat && (
              <div className="text-[11px] font-semibold text-slate-500 truncate mt-0.5">{stat}</div>
            )}
          </div>
        </div>
        <p className="text-sm font-semibold text-slate-800 mt-3 leading-snug break-words">{headline}</p>
        {hasMore && (
          <div className="mt-auto pt-2.5">
            <button type="button" onClick={() => setExpanded((e) => !e)}
              className="text-[11px] font-semibold hover:underline transition-colors"
              style={{ color: cat.color }}>
              {expanded ? 'Show less ↑' : 'Read more →'}
            </button>
            {expanded && <p className="text-xs text-slate-500 leading-relaxed mt-1.5 break-words">{narrative}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
