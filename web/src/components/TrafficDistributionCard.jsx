import { ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { TrendingUp } from 'lucide-react';

const num = (v) => Number(v || 0);

// GA4's default channel groups fold into these five buckets
const BUCKETS = ['Direct', 'Organic Search', 'Referral', 'Social', 'Other'];
const COLORS = { 
  'Direct': '#6C63FF', 
  'Organic Search': '#8b5cf6', 
  'Referral': '#38bdf8', 
  'Social': '#ec4899', 
  'Other': '#cbd5e1' 
};

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
    <div className="card p-6 flex flex-col justify-between">
      <div>
        <div className="flex items-start justify-between mb-6">
          <div>
            <h3 className="text-base font-bold text-slate-900 tracking-tight">Traffic Distribution</h3>
            <p className="text-xs text-slate-400 font-medium mt-0.5">Sessions by acquisition channel</p>
          </div>
        </div>

        {loading ? (
          <div className="py-14 text-center text-sm text-slate-400 animate-pulse font-medium">Loading distribution…</div>
        ) : total === 0 ? (
          <div className="py-14 text-center text-sm text-slate-400 font-medium">No session data for this range.</div>
        ) : (
          <div className="flex flex-col sm:flex-row items-center gap-6 py-2">
            <div className="relative shrink-0" style={{ width: 140, height: 140 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={pieRows} dataKey="value" nameKey="name" innerRadius={46} outerRadius={66}
                    paddingAngle={pieRows.length > 1 ? 4 : 0} stroke="none" startAngle={90} endAngle={-270}>
                    {pieRows.map((r) => <Cell key={r.name} fill={COLORS[r.name]} />)}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
                <div className="text-xl font-black text-slate-950 leading-none tabular-nums tracking-tight">
                  {total.toLocaleString()}
                </div>
                <div className="text-[9px] font-bold text-slate-400 uppercase tracking-wider mt-1">Sessions</div>
              </div>
            </div>
            <div className="flex-1 min-w-0 w-full space-y-2.5">
              {rows.map((r) => {
                const percentage = total ? Math.round((r.value / total) * 100) : 0;
                return (
                  <div key={r.name} className="flex items-center justify-between text-xs font-semibold px-2 py-1 hover:bg-slate-50 rounded-lg transition duration-150">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: COLORS[r.name] }} />
                      <span className="text-slate-600 truncate">{r.name}</span>
                    </div>
                    <span className="text-slate-900 font-bold tabular-nums pl-2 shrink-0">
                      {percentage}%
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {!loading && total > 0 && (
        <div className="mt-5 pt-4 border-t border-slate-100/80 flex items-start gap-3 bg-indigo-500/5 hover:bg-indigo-500/10 transition border border-indigo-500/10 rounded-2xl p-3.5">
          <span className="w-7 h-7 rounded-xl grid place-items-center shrink-0 bg-indigo-500/10 text-indigo-600">
            <TrendingUp size={14} strokeWidth={2.5} />
          </span>
          <p className="text-xs text-slate-600 leading-relaxed font-medium">
            <strong className="text-slate-900 font-bold">{leadShare}%</strong> of sessions acquired via <span className="font-bold text-indigo-600 underline decoration-indigo-200/60 decoration-2 underline-offset-2">{lead.name}</span>.
            {runnerUp && runnerUp.value === 0 && ` Expanding presence in ${runnerUp.name.toLowerCase()} would build reach.`}
          </p>
        </div>
      )}
    </div>
  );
}
