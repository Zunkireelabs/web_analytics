import { ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import Sparkline from './Sparkline.jsx';

/* ───────── helpers ───────── */
const num = (v) => Number(v || 0);
const fmt = (v) => num(v).toLocaleString();
const compact = (v) => {
  const n = num(v);
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return String(Math.round(n));
};
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const pathname = (v) => { try { return new URL(v).pathname || '/'; } catch { return v || '/'; } };
const iso = (d) => String(d).slice(0, 10);

// Restrained, indigo-led palette for the traffic donut — deliberately not a rainbow.
const CH_COLORS = ['#6C63FF', '#8b5cf6', '#38bdf8', '#34d399', '#fbbf24', '#cbd5e1'];

// Week-over-week from a daily series: the 7-day block ending at `date` vs the prior 7.
function wow(series, key, date) {
  if (!series?.length) return { pct: null };
  let end = series.findIndex((r) => iso(r.date) === date);
  if (end < 0) end = series.length - 1;
  const sum = (a, b) => series.slice(Math.max(0, a), b).reduce((s, r) => s + num(r[key]), 0);
  const thisW = sum(end - 6, end + 1);
  const lastW = sum(end - 13, end - 6);
  return { thisW, lastW, pct: lastW > 0 ? ((thisW - lastW) / lastW) * 100 : null };
}

/* ───────── shared bits ───────── */
function Delta({ value, className = '' }) {
  if (value == null) return <span className={`text-[11px] text-slate-300 ${className}`}>—</span>;
  const up = value >= 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-semibold tabular-nums ${up ? 'text-emerald-600' : 'text-rose-500'} ${className}`}>
      <span className="text-[9px]">{up ? '▲' : '▼'}</span>{Math.abs(value).toFixed(1)}%
    </span>
  );
}

// Pill-shaped insight badge. tone: 'neutral' | 'pos'
function Insight({ children, tone = 'neutral' }) {
  const styles = tone === 'pos'
    ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
    : 'bg-slate-50 text-slate-500 border-slate-100';
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full border ${styles}`}>
      <span className="text-[9px] opacity-70">◆</span>{children}
    </span>
  );
}

function CardHead({ title, sub, badge }) {
  return (
    <div className="flex items-start justify-between gap-3 mb-4">
      <div>
        <h3 className="text-[15px] font-semibold text-slate-900 tracking-tight">{title}</h3>
        {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
      </div>
      {badge}
    </div>
  );
}

/* ───────── ranked list (queries / pages) ───────── */
function RankedRow({ rank, label, full, value, sub, share, accent }) {
  return (
    <div className="group flex items-center gap-3 py-2.5 transition-colors rounded-xl hover:bg-slate-50/70 -mx-2 px-2">
      <span className="w-5 shrink-0 text-[11px] font-semibold text-slate-300 tabular-nums text-center">{rank}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm text-slate-700 truncate group-hover:text-slate-900" title={full}>{label}</span>
          <span className="text-sm font-semibold text-slate-900 tabular-nums shrink-0">{compact(value)}</span>
        </div>
        <div className="flex items-center gap-2 mt-1.5">
          <span className="h-1.5 flex-1 rounded-full bg-slate-100 overflow-hidden">
            <span className="block h-full rounded-full transition-[width] duration-500"
              style={{ width: `${Math.max(share, 3)}%`, background: accent }} />
          </span>
          <span className="text-[10px] text-slate-400 tabular-nums shrink-0 w-16 text-right">{sub}</span>
        </div>
      </div>
    </div>
  );
}

function RankedList({ rows, valueKey, labelFn, accent, empty }) {
  const list = [...(rows || [])]
    .sort((a, b) => num(b[valueKey]) - num(a[valueKey]))
    .slice(0, 6);
  const max = Math.max(1, ...list.map((r) => num(r[valueKey])));
  if (list.length === 0) return <div className="text-sm text-slate-400 py-8 text-center">{empty}</div>;
  return (
    <div className="divide-y divide-slate-50">
      {list.map((r, i) => (
        <RankedRow key={i} rank={i + 1}
          label={labelFn(r.dim_value)} full={r.dim_value}
          value={num(r[valueKey])} sub={`${fmt(r.clicks)} clicks`}
          share={pct(num(r[valueKey]), max)} accent={accent} />
      ))}
    </div>
  );
}

/* ───────── traffic donut ───────── */
function TrafficDonut({ channels }) {
  const rows = [...(channels || [])]
    .map((r) => ({ name: r.channel, value: num(r.sessions) }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
  // Collapse the long tail into "Other" so the ring stays legible.
  const head = rows.slice(0, 5);
  const tail = rows.slice(5).reduce((s, r) => s + r.value, 0);
  const data = tail > 0 ? [...head, { name: 'Other', value: tail }] : head;
  const total = data.reduce((s, r) => s + r.value, 0);
  const lead = data[0];

  if (total === 0) {
    return (
      <div className="card card-hover p-6 flex flex-col">
        <CardHead title="Traffic Distribution" sub="Sessions by channel" />
        <div className="flex-1 grid place-items-center py-10 text-center">
          <div>
            <div className="w-12 h-12 rounded-full grid place-items-center text-xl mx-auto" style={{ background: 'rgba(108,99,255,0.08)' }}>◷</div>
            <div className="text-sm text-slate-400 mt-3">No channel data yet</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card card-hover p-6 flex flex-col">
      <CardHead title="Traffic Distribution" sub="Sessions by acquisition channel"
        badge={<Insight tone="pos">{lead.name} · {pct(lead.value, total)}%</Insight>} />
      <div className="flex items-center gap-6 flex-1">
        {/* ring with centered total */}
        <div className="relative shrink-0" style={{ width: 168, height: 168 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="name" innerRadius={62} outerRadius={82}
                paddingAngle={2} stroke="none" startAngle={90} endAngle={-270}>
                {data.map((_, i) => <Cell key={i} fill={CH_COLORS[i % CH_COLORS.length]} />)}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 grid place-content-center text-center pointer-events-none">
            <div className="text-[26px] font-bold text-slate-900 leading-none tabular-nums tracking-tight">{compact(total)}</div>
            <div className="text-[11px] text-slate-400 mt-1">sessions</div>
          </div>
        </div>
        {/* legend */}
        <div className="flex-1 min-w-0 space-y-2.5">
          {data.map((r, i) => (
            <div key={r.name} className="flex items-center gap-2.5">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: CH_COLORS[i % CH_COLORS.length] }} />
              <span className="text-sm text-slate-600 truncate flex-1">{r.name}</span>
              <span className="text-sm font-semibold text-slate-900 tabular-nums">{pct(r.value, total)}%</span>
              <span className="text-[11px] text-slate-400 tabular-nums w-12 text-right">{compact(r.value)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ───────── headline metric tile ───────── */
function MetricTile({ label, value, spark, color, delta, divider }) {
  return (
    <div className={`px-6 py-5 ${divider ? 'lg:border-l border-slate-100' : ''}`}>
      <div className="text-xs font-medium text-slate-400">{label}</div>
      <div className="mt-2 flex items-end justify-between gap-2">
        <div className="text-[34px] leading-none font-bold text-slate-900 tracking-tight tabular-nums">{value}</div>
        {spark && <div className="pb-1"><Sparkline data={spark} color={color} /></div>}
      </div>
      {delta !== undefined && (
        <div className="mt-2.5"><Delta value={delta} /><span className="text-[11px] text-slate-400 ml-1.5">vs last week</span></div>
      )}
    </div>
  );
}

/* ───────── the section ───────── */
export default function PerformanceSection({ day, series = [], reportDate, loading }) {
  const queries = day?.queries || [];
  const pages = day?.pages || [];
  const channels = day?.channels || [];

  const queryImpr = queries.reduce((s, r) => s + num(r.impressions), 0);
  const pageImpr = pages.reduce((s, r) => s + num(r.impressions), 0);
  const sessions = channels.reduce((s, r) => s + num(r.sessions), 0);

  const sv = (k) => series.map((r) => num(r[k]));
  const imprWow = wow(series, 'impressions', reportDate);
  const sessWow = wow(series, 'sessions', reportDate);

  // top-3 concentration insights
  const q3 = [...queries].sort((a, b) => num(b.impressions) - num(a.impressions)).slice(0, 3)
    .reduce((s, r) => s + num(r.impressions), 0);
  const topPage = [...pages].sort((a, b) => num(b.impressions) - num(a.impressions))[0];

  if (loading && !day) {
    return <div className="card p-10 text-center text-sm text-slate-400">Loading performance…</div>;
  }

  return (
    <section className="space-y-5">
      <div className="flex items-center gap-2.5">
        <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
        <h2 className="text-sm font-semibold text-slate-700 tracking-tight">Performance Intelligence</h2>
        <span className="text-[11px] text-slate-400 bg-slate-100 rounded-full px-2 py-0.5">finalized · {reportDate}</span>
      </div>

      {/* ── TOP ROW: full-width performance overview ── */}
      <div className="card card-hover overflow-hidden">
        <div className="flex items-center justify-between px-6 pt-5">
          <CardHead title="Performance Overview" sub="Search reach & audience for the latest finalized day" />
          <div className="-mt-1">
            <Insight tone={imprWow.pct >= 0 ? 'pos' : 'neutral'}>
              Impressions {imprWow.pct == null ? '—' : `${imprWow.pct >= 0 ? '+' : ''}${imprWow.pct.toFixed(1)}%`} WoW
            </Insight>
          </div>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 divide-slate-100">
          <MetricTile label="Query Impressions" value={compact(queryImpr)} spark={sv('impressions')} color="#6C63FF" delta={imprWow.pct} />
          <MetricTile label="Page Impressions" value={compact(pageImpr)} spark={sv('impressions')} color="#8b5cf6" delta={imprWow.pct} divider />
          <MetricTile label="Total Sessions" value={compact(sessions)} spark={sv('sessions')} color="#34d399" delta={sessWow.pct} divider />
          {/* WoW growth — framed headline tile */}
          <div className="px-6 py-5 lg:border-l border-slate-100 bg-gradient-to-b from-indigo-50/40 to-transparent">
            <div className="text-xs font-medium text-slate-400">Week-over-Week Growth</div>
            <div className="mt-2 flex items-baseline gap-1.5">
              <span className={`text-[34px] leading-none font-bold tracking-tight tabular-nums ${(imprWow.pct ?? 0) >= 0 ? 'text-emerald-600' : 'text-rose-500'}`}>
                {imprWow.pct == null ? '—' : `${(imprWow.pct >= 0 ? '+' : '') + imprWow.pct.toFixed(1)}`}
              </span>
              {imprWow.pct != null && <span className="text-lg font-semibold text-slate-300">%</span>}
            </div>
            <div className="mt-2.5 text-[11px] text-slate-400">
              {compact(imprWow.lastW)} → <span className="text-slate-600 font-medium">{compact(imprWow.thisW)}</span> impressions
            </div>
          </div>
        </div>
      </div>

      {/* ── MIDDLE ROW: top queries (40%) + traffic donut (60%) ── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
        <div className="lg:col-span-2 card card-hover p-6">
          <CardHead title="Top Queries" sub="Ranked by impressions"
            badge={<Insight>Top 3 · {pct(q3, queryImpr)}%</Insight>} />
          <RankedList rows={queries} valueKey="impressions" labelFn={(v) => v} accent="#6C63FF" empty="No query data." />
        </div>
        <div className="lg:col-span-3">
          <TrafficDonut channels={channels} />
        </div>
      </div>

      {/* ── BOTTOM ROW: full-width top pages ── */}
      <div className="card card-hover p-6">
        <CardHead title="Top Pages" sub="Ranked by impressions"
          badge={topPage ? <Insight>Lead page · {pct(num(topPage.impressions), pageImpr)}%</Insight> : null} />
        <div className="grid sm:grid-cols-2 gap-x-10">
          <RankedList rows={pages} valueKey="impressions" labelFn={pathname} accent="#8b5cf6" empty="No page data." />
          <div className="hidden sm:block">
            <RankedListOffset rows={pages} accent="#8b5cf6" />
          </div>
        </div>
      </div>
    </section>
  );
}

// Right column of Top Pages: ranks 7–12 so the full-width card actually uses its width.
function RankedListOffset({ rows, accent }) {
  const list = [...(rows || [])]
    .sort((a, b) => num(b.impressions) - num(a.impressions))
    .slice(6, 12);
  const max = Math.max(1, ...(rows || []).map((r) => num(r.impressions)));
  if (list.length === 0) return <div className="text-sm text-slate-300 py-8 text-center">All ranked pages shown</div>;
  return (
    <div className="divide-y divide-slate-50">
      {list.map((r, i) => (
        <RankedRow key={i} rank={i + 7}
          label={pathname(r.dim_value)} full={r.dim_value}
          value={num(r.impressions)} sub={`${fmt(r.clicks)} clicks`}
          share={pct(num(r.impressions), max)} accent={accent} />
      ))}
    </div>
  );
}
