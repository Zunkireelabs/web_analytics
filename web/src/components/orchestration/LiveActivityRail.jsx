import { timeAgo } from '../../api.js';
import { CATEGORY } from '../AgentCard.jsx';

// Dark-theme sibling of ActivityFeed.jsx (Command Center's light-theme
// version) — same real data (GET /agents/activity → getAgentActivityFeed,
// which shares its row shape with Command Center's activity feed), just
// restyled for this page's navy background and re-polled every 20s by the
// parent (AiGrowth.jsx) so it reads as a live feed, not a one-time snapshot.
export default function LiveActivityRail({ items }) {
  return (
    <div className="rounded-2xl overflow-hidden flex flex-col"
      style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02))', border: '1px solid rgba(255,255,255,0.1)', maxHeight: 260 }}>
      <div className="flex items-center gap-2 px-4 py-3 shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60" style={{ background: '#34d399' }} />
          <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: '#34d399' }} />
        </span>
        <p className="text-[11px] font-bold uppercase tracking-widest text-white/60">Live Activity</p>
      </div>

      <div className="overflow-y-auto flex-1">
        {items === null ? (
          <div className="p-4 space-y-2.5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-8 rounded-lg animate-pulse" style={{ background: 'rgba(255,255,255,0.04)' }} />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="text-[12px] text-white/35 text-center py-8 px-4">No agent activity yet.</p>
        ) : (
          <div>
            {items.map((a, i) => {
              const cat = CATEGORY[a.category] || CATEGORY.seo;
              const failed = a.status !== 'ok';
              return (
                <div key={i} className="flex items-center gap-2.5 px-4 py-2" style={{ borderTop: i ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                  <span className="w-6 h-6 rounded-lg grid place-items-center text-[11px] shrink-0"
                    style={failed ? { background: 'rgba(255,255,255,0.06)', color: '#94a3b8' } : { background: `${cat.color}26`, color: cat.color }}>
                    {cat.icon}
                  </span>
                  <span className={`text-[11.5px] flex-1 min-w-0 truncate ${failed ? 'text-white/35' : 'text-white/75'}`}>
                    {failed ? `Attempted: ${a.label.charAt(0).toLowerCase() + a.label.slice(1)}` : a.label}
                  </span>
                  <span className="text-[10px] text-white/35 font-mono shrink-0">{timeAgo(a.createdAt)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
