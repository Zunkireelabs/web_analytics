import { timeAgo } from '../api.js';

// What the AI has been doing in the background — every row is a real
// persisted agent_runs entry (agentId + createdAt), not a status simulation.
// This is what makes "your analyst already did the work" concrete instead
// of just a greeting-bar claim.
export default function ActivityFeed({ items }) {
  if (!items?.length) {
    return <div className="card p-6 text-center text-sm text-slate-400">No activity yet.</div>;
  }
  return (
    <div className="card divide-y divide-slate-50">
      {items.map((a, i) => {
        const attempted = a.status !== 'ok'; // e.g. competitor check with no credentials configured yet
        return (
          <div key={i} className="flex items-center gap-3 px-4 py-2.5">
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: attempted ? '#cbd5e1' : '#6C63FF' }} />
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
