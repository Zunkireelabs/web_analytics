// Traffic by channel — colored magnitude bars per channel, with a friendly empty state.
const COLORS = {
  'Organic Search': '#6C63FF', 'Direct': '#10b981', 'Referral': '#f59e0b',
  'Organic Social': '#ec4899', 'Social': '#ec4899', 'Email': '#0ea5e9',
  'Paid Search': '#8b5cf6', 'Display': '#14b8a6', 'Unassigned': '#94a3b8',
};
const color = (c) => COLORS[c] || '#6C63FF';

export default function ChannelChart({ data }) {
  const rows = (data || [])
    .map((r) => ({ channel: r.channel, sessions: Number(r.sessions) || 0 }))
    .sort((a, b) => b.sessions - a.sessions);
  const max = Math.max(1, ...rows.map((r) => r.sessions));

  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between mb-3">
        <div className="card-title">Traffic by channel</div>
        <span className="text-[11px] text-slate-400">selected range</span>
      </div>
      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="w-12 h-12 rounded-full grid place-items-center text-xl"
            style={{ background: 'rgba(108,99,255,0.08)' }}>📊</div>
          <div className="text-sm text-slate-400 mt-3">No channel data for this day</div>
          <div className="text-xs text-slate-300 mt-0.5">Visitor data appears once there's traffic</div>
        </div>
      ) : (
        <div className="space-y-3 pt-1">
          {rows.map((r) => (
            <div key={r.channel}>
              <div className="flex items-center justify-between text-sm mb-1">
                <span className="flex items-center gap-2 text-slate-600">
                  <span className="w-2 h-2 rounded-full" style={{ background: color(r.channel) }} />
                  {r.channel}
                </span>
                <span className="font-semibold text-slate-800">{r.sessions.toLocaleString()}</span>
              </div>
              <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                <div className="h-full rounded-full transition-all"
                  style={{ width: `${(r.sessions / max) * 100}%`, background: color(r.channel) }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
