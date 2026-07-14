import { timeAgo } from '../api.js';
import { CATEGORY } from './AgentCard.jsx';

// What the AI has been doing in the background — every row is a real
// persisted agent_runs entry (agentId + createdAt), not a status simulation.
// This is what makes "your analyst already did the work" concrete instead
// of just a greeting-bar claim. Icon chips reuse the same category
// identity (color + icon) as AgentCard/AgentFindingCard, so a reader can
// tell at a glance which specialist did what without reading every label.
export default function ActivityFeed({ items }) {
  if (!items?.length) {
    return <div className="card p-6 text-center text-sm text-slate-400">No activity yet.</div>;
  }
  return (
    <div className="card divide-y divide-slate-50">
      {items.map((a, i) => {
        const attempted = a.status !== 'ok'; // e.g. competitor check with no credentials configured yet
        const cat = CATEGORY[a.category] || CATEGORY.seo;
        return (
          <div key={i} className="flex items-center gap-3 px-4 py-2.5">
            <span className="w-7 h-7 rounded-lg grid place-items-center text-[12px] shrink-0"
              style={attempted ? { background: '#f1f5f9', color: '#94a3b8' } : { background: `${cat.color}1a`, color: cat.color }}>
              {cat.icon}
            </span>
            <span className={`text-[13px] flex-1 min-w-0 ${attempted ? 'text-slate-400' : 'text-slate-700'}`}>
              {attempted ? `Attempted: ${a.label.charAt(0).toLowerCase() + a.label.slice(1)}` : a.label}
            </span>
            <span className="text-[11px] text-slate-400 font-mono shrink-0">{timeAgo(a.createdAt)}</span>
          </div>
        );
      })}
    </div>
  );
}
