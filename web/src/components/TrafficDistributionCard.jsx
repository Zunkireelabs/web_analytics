import { ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { TrendingUp } from 'lucide-react';

const num = (v) => Number(v || 0);

// GA4's default channel groups fold into these five buckets — keeps the legend
// stable and readable even as new/unusual channel names show up over time.
const BUCKETS = ['Direct', 'Organic Search', 'Referral', 'Social', 'Other'];
const COLORS = { 'Direct': '#6C63FF', 'Organic Search': '#a5b4fc', 'Referral': '#c4b5fd', 'Social': '#f0abfc', 'Other': '#e2e8f0' };

function bucketOf(channel) {
  const c = String(channel || '');
  if (BUCKETS.slice(0, 3).includes(c)) return c;
  if (/social/i.test(c)) return 'Social';
  return 'Other';
}

export default function TrafficDistributionCard({ channels, loading }) {
  const byBucket = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  for (const r of channels || []) byBucket[bucketOf(r.channel)] += num(r.sessions);
  const total = BUCKETS.reduce((s, b) => s + byBucket[b], 0);
  const rows = BUCKETS.map((name) => ({ name, value: byBucket[name] }));
  const pieRows = rows.filter((r) => r.value > 0);
  const lead = [...rows].sort((a, b) => b.value - a.value)[0];
  const leadShare = total > 0 ? Math.round((lead.value / total) * 100) : 0;
  const runnerUp = [...rows].filter((r) => r.name !== lead.name).sort((a, b) => b.value - a.value)[0];

  return (
    <div className="card p-6 flex flex-col">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-[15px] font-semibold text-slate-900 tracking-tight">Traffic Distribution</h3>
          <p className="text-xs text-slate-400 mt-0.5">Sessions by acquisition channel</p>
        </div>
      </div>

      {loading ? (
        <div className="py-10 text-center text-sm text-slate-400 animate-pulse">Loading…</div>
      ) : total === 0 ? (
        <div className="py-10 text-center text-sm text-slate-400">No session data for this range.</div>
      ) : (
        <>
          <div className="flex items-center gap-5">
            <div className="relative shrink-0" style={{ width: 132, height: 132 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={pieRows} dataKey="value" nameKey="name" innerRadius={44} outerRadius={62}
                    paddingAngle={pieRows.length > 1 ? 3 : 0} stroke="none" startAngle={90} endAngle={-270}>
                    {pieRows.map((r) => <Cell key={r.name} fill={COLORS[r.name]} />)}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 grid place-content-center text-center pointer-events-none">
                <div className="text-xl font-bold text-slate-900 leading-none tabular-nums">{total.toLocaleString()}</div>
                <div className="text-[10px] text-slate-400 mt-1">Total Sessions</div>
              </div>
            </div>
            <div className="flex-1 min-w-0 space-y-2">
              {rows.map((r) => (
                <div key={r.name} className="flex items-center gap-2 text-[13px]">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: COLORS[r.name] }} />
                  <span className="text-slate-600 truncate flex-1">{r.name}</span>
                  <span className="text-slate-900 font-semibold tabular-nums shrink-0">
                    {total ? Math.round((r.value / total) * 100) : 0}%
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-auto pt-4 border-t border-slate-50 flex items-start gap-2.5">
            <span className="w-6 h-6 rounded-md grid place-items-center shrink-0 bg-indigo-50 text-indigo-600 mt-0.5">
              <TrendingUp size={13} strokeWidth={2.25} />
            </span>
            <p className="text-xs text-slate-500 leading-relaxed">
              {leadShare}% of your traffic came via <span className="font-semibold text-slate-700">{lead.name}</span>.
              {runnerUp && runnerUp.value === 0 && ` Consider improving visibility in ${runnerUp.name.toLowerCase()}.`}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
