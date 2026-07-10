import { useState, useEffect } from 'react';
import { api } from '../api.js';

const GREEN = '#16A34A';
const RED = '#EF4444';
const BLUE = '#2563EB';
const PURPLE = '#8B5CF6';

const sum = (arr, k) => (arr || []).reduce((a, r) => a + (Number(r[k]) || 0), 0);
const fmtSigned = (n) => `${n >= 0 ? '+' : ''}${n.toLocaleString()}`;

function changePct(prior, delta) {
  const p = Number(prior);
  if (p === 0) return { text: 'New', isNew: true };
  const v = Math.round((Number(delta) / p) * 100);
  return { text: `${v >= 0 ? '+' : ''}${v}%`, isNew: false };
}

export default function MoversList({ gainers = [], droppers = [] }) {
  const netChange = sum(gainers, 'delta') + sum(droppers, 'delta');
  const recentTotal = sum(gainers, 'recent') + sum(droppers, 'recent');
  const priorTotal = sum(gainers, 'prior') + sum(droppers, 'prior');
  const pct = priorTotal ? Math.round((netChange / priorTotal) * 100) : null;
  const changed = gainers.length + droppers.length;

  return (
    <div className="space-y-6">
      {/* 1 ─ Summary card */}
      <div className="card p-6">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-bold text-[#0F172A]">Search Query Movement</h3>
              <InfoIcon />
            </div>
            <p className="text-sm text-[#64748B] mt-1">Clicks performance vs last week</p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 flex-1 min-w-[320px] max-w-2xl">
            <Metric icon={<TrendUp />} tint={GREEN} value={fmtSigned(netChange)} label="Net click change"
              badge={pct != null ? `${pct >= 0 ? '+' : ''}${pct}%` : null} badgeUp={netChange >= 0} />
            <Metric icon={<Activity />} tint={BLUE} value={recentTotal.toLocaleString()} label="This week"
              sub={`vs ${priorTotal.toLocaleString()} last week`} />
            <Metric icon={<Target />} tint={PURPLE} value={changed} label="Queries changed" />
            <Metric icon={<Swap />} tint={GREEN}
              value={<span><span style={{ color: GREEN }}>{gainers.length}</span> <span className="text-slate-300">/</span> <span style={{ color: RED }}>{droppers.length}</span></span>}
              label="Gainers / Losers" />
          </div>
        </div>
      </div>

      {/* 2 ─ AI Insights band */}
      <AiInsights gainers={gainers} droppers={droppers} />

      {/* 3 ─ Two-column gainers / drops */}
      <div id="movers-section" className="grid md:grid-cols-2 gap-6">
        <MoverCard kind="gain" rows={gainers} total={gainers.length} />
        <MoverCard kind="drop" rows={droppers} total={droppers.length} />
      </div>
    </div>
  );
}

/* ───────── Summary metric tile ───────── */
function Metric({ icon, tint, value, label, badge, badgeUp, sub }) {
  return (
    <div className="rounded-2xl border border-[#E2E8F0] p-3 card-hover bg-white">
      <div className="flex items-center justify-between">
        <span className="w-8 h-8 rounded-lg grid place-items-center" style={{ background: `${tint}1a`, color: tint }}>{icon}</span>
        {badge && (
          <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-md"
            style={badgeUp ? { background: '#dcfce7', color: GREEN } : { background: '#fee2e2', color: RED }}>{badge}</span>
        )}
      </div>
      <div className="text-xl font-bold text-[#0F172A] mt-2 leading-none">{value}</div>
      <div className="text-[11px] text-[#64748B] mt-1">{label}</div>
      {sub && <div className="text-[10px] text-slate-400 mt-0.5">{sub}</div>}
    </div>
  );
}

/* ───────── AI Insights band ───────── */
function AiInsights({ gainers, droppers }) {
  const used = new Set();
  const take = (q) => { if (q) used.add(q.query); return q; };

  const topGain = take(gainers[0]);
  const newQ = take(gainers.find((g) => !used.has(g.query) && Number(g.prior) === 0));
  const vsQ = take([...gainers, ...droppers].find((q) => !used.has(q.query) && / vs /i.test(q.query)));
  const topDrop = take(droppers[0]);

  // Auto-translate the handful of highlighted queries here (bounded to ≤4 calls,
  // cached server-side so repeat loads are instant).
  const highlighted = [topGain, newQ, vsQ, topDrop].filter(Boolean).map((q) => q.query);
  const [translations, setTranslations] = useState({});
  useEffect(() => {
    highlighted.forEach((q) => {
      api.translate(q).then((t) => {
        if (t.language !== 'English') setTranslations((prev) => ({ ...prev, [q]: t.translation }));
      }).catch(() => {});
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlighted.join('|')]);
  const withTranslation = (q, text) => translations[q] ? `${text} (“${translations[q]}”)` : text;

  const blocks = [];
  if (topGain) {
    const c = changePct(topGain.prior, topGain.delta);
    blocks.push({ icon: <TrendUp />, color: GREEN, tag: 'Gainer', head: `“${topGain.query}”`, text: withTranslation(topGain.query, `Highest growth · ${c.isNew ? `+${topGain.recent} clicks` : `${c.text} clicks`}`) });
  }
  if (newQ) blocks.push({ icon: <Sparkle />, color: GREEN, tag: 'New', head: `“${newQ.query}”`, text: withTranslation(newQ.query, newQ.page ? `+${newQ.recent} new clicks → ${newQ.page}` : `+${newQ.recent} new clicks this week`) });
  if (vsQ) blocks.push({ icon: <Activity />, color: GREEN, tag: 'Trending', head: `“${vsQ.query}”`, text: withTranslation(vsQ.query, 'Comparison searches gaining momentum') });
  if (topDrop) blocks.push({ icon: <TrendDown />, color: RED, tag: 'Drop', head: `“${topDrop.query}”`, text: withTranslation(topDrop.query, 'Lost the most visibility — refresh content') });

  if (blocks.length === 0) return null;

  return (
    <div className="rounded-2xl border p-5" style={{ borderColor: '#E5F5EC', background: 'linear-gradient(135deg,#f0fdf4,#ffffff 85%)' }}>
      <div className="flex items-center gap-2 mb-4">
        <span className="text-sm font-bold" style={{ color: GREEN }}>✨ AI Insights</span>
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: '#dcfce7', color: GREEN }}>Beta</span>
      </div>
      <div className="flex flex-wrap gap-3">
        {blocks.map((b, i) => (
          <div key={i} className="flex items-start gap-3 flex-1 min-w-[220px] rounded-xl bg-white/80 border border-white p-3.5 shadow-sm">
            <span className="w-9 h-9 rounded-full grid place-items-center shrink-0" style={{ background: `${b.color}1a`, color: b.color }}>{b.icon}</span>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full" style={{ background: `${b.color}1a`, color: b.color }}>{b.tag}</span>
              </div>
              <div className="text-sm font-semibold text-[#0F172A] leading-snug mt-1 truncate" title={b.head}>{b.head}</div>
              <div className="text-[12px] text-[#64748B] leading-snug">{b.text}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───────── Gainers / Drops card ───────── */
function MoverCard({ kind, rows, total }) {
  const [showAll, setShowAll] = useState(false);
  const gain = kind === 'gain';
  const color = gain ? GREEN : RED;
  const soft = gain ? '#dcfce7' : '#fee2e2';
  const displayRows = showAll ? (rows || []) : (rows || []).slice(0, 7);
  const hasMore = (rows || []).length > 7;
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between p-5 pb-3">
        <div className="flex items-center gap-2.5">
          <span className="w-9 h-9 rounded-xl grid place-items-center text-white" style={{ background: color }}>
            {gain ? <TrendUp /> : <TrendDown />}
          </span>
          <h3 className="font-bold text-[#0F172A]">{gain ? 'Top Gainers' : 'Top Drops'}</h3>
        </div>
        <span className="text-xs font-semibold px-2.5 py-1 rounded-full" style={{ background: soft, color }}>
          {gain ? '↑' : '↓'} {total} queries
        </span>
      </div>

      {/* column header */}
      <div className="grid grid-cols-[24px_1fr_64px_64px_64px] items-center gap-2 px-5 pb-2 text-[10px] uppercase tracking-wide text-slate-400">
        <span></span><span>Query</span><span className="text-right">Change</span><span className="text-right">%</span><span className="text-right">Trend</span>
      </div>

      <div className="px-2">
        {displayRows.length === 0 && <div className="text-sm text-slate-400 px-3 py-4">No movement.</div>}
        {displayRows.map((r, i) => {
          const c = changePct(r.prior, r.delta);
          return (
            <div key={i} className="grid grid-cols-[24px_1fr_64px_64px_64px] items-center gap-2 px-3 py-2.5 rounded-lg hover:bg-slate-50 transition">
              <span className="w-6 h-6 rounded-md grid place-items-center text-[11px] font-bold" style={{ background: soft, color }}>{i + 1}</span>
              <span className="min-w-0">
                <span className="flex items-center gap-1 min-w-0">
                  <span className="text-sm text-[#0F172A] truncate" title={r.query}>{r.query}</span>
                  <TranslateButton query={r.query} />
                </span>
                {r.page && (
                  <span className="block text-[10px] text-slate-400 truncate" title={r.page}>
                    → {r.page}{(r.device || r.country) && ` (${[r.device?.toLowerCase(), r.country].filter(Boolean).join(' · ')})`}
                  </span>
                )}
              </span>
              <span className="text-right text-sm font-semibold" style={{ color }}>{fmtSigned(r.delta)}</span>
              <span className="text-right">
                <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-md"
                  style={c.isNew ? { background: '#dbeafe', color: BLUE } : { background: soft, color }}>{c.text}</span>
              </span>
              <span className="flex justify-end"><MiniSpark from={r.prior} to={r.recent} color={color} /></span>
            </div>
          );
        })}
      </div>

      {hasMore && (
        <button className="w-full text-sm font-semibold py-3 mt-1 transition hover:brightness-95"
          style={{ background: soft, color }}
          onClick={() => setShowAll((s) => !s)}>
          {showAll ? `Show less ↑` : `View all ${gain ? 'gainers' : 'drops'} (${total}) →`}
        </button>
      )}
    </div>
  );
}

/* ───────── Click-to-reveal translation ───────── */
function TranslateButton({ query }) {
  const [state, setState] = useState(null); // null | 'loading' | { language, translation }
  if (state && state !== 'loading' && (state.language === 'English' || !state.translation)) return null;
  return (
    <span className="shrink-0">
      {!state && (
        <button
          type="button"
          className="text-[10px] text-slate-400 hover:text-slate-600 leading-none"
          title="Translate query"
          onClick={async (e) => {
            e.stopPropagation();
            setState('loading');
            try { setState(await api.translate(query)); }
            catch { setState({ language: 'unknown', translation: '' }); }
          }}
        >🌐</button>
      )}
      {state === 'loading' && <span className="text-[10px] text-slate-300">…</span>}
      {state && state !== 'loading' && state.translation && (
        <span className="text-[10px] text-slate-400 italic" title={state.language}> “{state.translation}”</span>
      )}
    </span>
  );
}

function MiniSpark({ from, to, color }) {
  const a = Number(from) || 0, b = Number(to) || 0;
  const steps = [a, a + (b - a) * 0.2, a + (b - a) * 0.45, a + (b - a) * 0.62, a + (b - a) * 0.82, b];
  const min = Math.min(...steps), max = Math.max(...steps), range = max - min || 1;
  const pts = steps.map((v, i) => `${((i / (steps.length - 1)) * 54).toFixed(1)},${(17 - ((v - min) / range) * 15).toFixed(1)}`).join(' ');
  return (
    <svg width="54" height="20" className="shrink-0">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ───────── Inline lucide-style icons ───────── */
const S = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };
const TrendUp = () => (<svg {...S}><polyline points="22 7 13.5 15.5 8.5 10.5 2 17" /><polyline points="16 7 22 7 22 13" /></svg>);
const TrendDown = () => (<svg {...S}><polyline points="22 17 13.5 8.5 8.5 13.5 2 7" /><polyline points="16 17 22 17 22 11" /></svg>);
const Activity = () => (<svg {...S}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>);
const Target = () => (<svg {...S}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></svg>);
const Swap = () => (<svg {...S}><polyline points="17 4 21 8 17 12" /><path d="M21 8H7" /><polyline points="7 20 3 16 7 12" /><path d="M3 16h14" /></svg>);
const Sparkle = () => (<svg {...S}><path d="M12 3v4M12 17v4M5 12H1M23 12h-4M6 6l2 2M16 16l2 2M18 6l-2 2M8 16l-2 2" /></svg>);
const InfoIcon = () => (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></svg>);
