import { timeAgo } from '../api.js';

const MARKER = {
  health: (positive) => <span className={positive ? 'text-emerald-600' : 'text-rose-500'}>{positive ? '↑' : '↓'}</span>,
  resolved: () => <span className="text-emerald-600">✓</span>,
  new: () => <span className="text-rose-500">●</span>,
};
const PREFIX = { health: '', resolved: 'Resolved: ', new: 'New: ' };

// New-vs-resolved since the last analysis run (diffed server-side by finding
// id — see agents/lib/command-center.js's getRecentChanges), plus one
// week-over-week health delta entry when available. Reinforces continuous
// work: things get fixed between visits, not just discovered.
export default function ChangesTimeline({ items }) {
  if (!items?.length) {
    return <div className="card p-6 text-center text-sm text-slate-400">No changes since the last analysis.</div>;
  }
  return (
    <div className="card divide-y divide-slate-50">
      {items.map((c, i) => (
        <div key={i} className="flex items-start gap-3 px-4 py-3">
          <span className="mt-0.5 shrink-0 text-sm">{(MARKER[c.type] || MARKER.new)(c.positive)}</span>
          <div className="min-w-0">
            <p className="text-[13px] text-slate-700 leading-snug">
              <span className="font-semibold">{PREFIX[c.type] ?? ''}</span>
              {c.text}
            </p>
            <p className="text-[11px] text-slate-400 mt-0.5">{timeAgo(c.at)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
