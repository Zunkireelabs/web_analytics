import { ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import Section from './layout/Section.jsx';
import { SERIES, CHART } from '../lib/palette.js';

const num = (v) => Number(v || 0);

// GA4's default channel groups fold into these five buckets
const BUCKETS = ['Direct', 'Organic Search', 'Referral', 'Social', 'Other'];
const COLORS = { 
  'Direct': SERIES[0], 
  'Organic Search': SERIES[1], 
  'Referral': SERIES[2], 
  'Social': SERIES[3], 
  'Other': CHART.muted 
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

  return (
    <Section label="Traffic" source="Google Analytics" title="Traffic distribution" subtitle="Sessions by acquisition channel">
      <div className="card p-5 flex flex-wrap items-center gap-6">
        {loading ? (
          <div className="w-full py-9 text-center text-sm text-faint">Loading distribution…</div>
        ) : total === 0 ? (
          <div className="w-full py-9 text-center text-sm text-faint">No session data for this range.</div>
        ) : (
          <>
            <div className="relative shrink-0" style={{ width: 140, height: 140 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={pieRows} dataKey="value" nameKey="name" innerRadius={52} outerRadius={66}
                    paddingAngle={2} startAngle={90} endAngle={-270}>
                    {pieRows.map((r) => <Cell key={r.name} fill={COLORS[r.name]} stroke="#fff" />)}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
                <div className="text-[22px] font-medium tnum text-fg leading-none">{total.toLocaleString()}</div>
                <div className="text-xs text-faint mt-1">sessions</div>
              </div>
            </div>
            <div className="flex-1 min-w-[180px]">
              {rows.map((r) => {
                const percentage = total ? Math.round((r.value / total) * 100) : 0;
                return (
                  <div key={r.name} className="flex items-center justify-between py-2 border-b border-border last:border-0 text-sm">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: COLORS[r.name] }} />
                      <span className="text-fg truncate">{r.name}</span>
                    </div>
                    <span className="tnum text-text pl-2 shrink-0">{percentage}%</span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </Section>
  );
}
