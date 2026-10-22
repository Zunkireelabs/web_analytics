import { timeAgo } from '../../api.js';
import { ORCH_CATEGORY as CATEGORY } from './palette.js';

// Real recent agent runs (GET /agents/activity → getAgentActivityFeed, which
// shares its row shape with Command Center's activity feed), re-polled every
// 20s by the parent (AiGrowth.jsx) so it reads as a live feed, not a one-time
// snapshot. Renders only its box; the section title comes from the parent.
export default function LiveActivityRail({ items }) {
  return (
    <div className="border-t border-border flex flex-col" style={{ maxHeight: 320 }}>
      <div className="overflow-y-auto flex-1 custom-scrollbar">
        {items === null ? (
          <div className="p-4 space-y-2.5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-7 rounded-control bg-muted animate-pulse" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="text-sm text-faint text-center py-10 px-4">No agent activity yet.</p>
        ) : (
          items.map((a, i) => {
            const cat = CATEGORY[a.category] || CATEGORY.seo;
            const failed = a.status !== 'ok';
            return (
              <div key={i} className="flex items-center gap-2.5 px-4 py-2.5 border-t border-border first:border-t-0">
                <span className="w-7 h-7 rounded-control bg-muted grid place-items-center shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: failed ? '#a3a3a3' : cat.color }} />
                </span>
                <span className={`text-[13px] flex-1 min-w-0 truncate ${failed ? 'text-faint' : 'text-fg'}`}>
                  {failed ? `Attempted: ${a.label.charAt(0).toLowerCase() + a.label.slice(1)}` : a.label}
                </span>
                <span className="text-xs text-faint tnum shrink-0">{timeAgo(a.createdAt)}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
