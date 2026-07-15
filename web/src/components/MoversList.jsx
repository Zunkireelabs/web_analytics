import { useState, useEffect } from 'react';
import { api } from '../api.js';
import Sparkline from './Sparkline.jsx';
import { ArrowUpRight, ArrowDownRight, Info } from 'lucide-react';

const GREEN = '#10b981';
const RED = '#f43f5e';
const BLUE = '#3b82f6';
const PURPLE = '#8b5cf6';

const sum = (arr, k) => (arr || []).reduce((a, r) => a + (Number(r[k]) || 0), 0);
const fmtSigned = (n) => `${n >= 0 ? '+' : ''}${n.toLocaleString()}`;

function changePct(prior, delta) {
  const p = Number(prior);
  if (p === 0) return { text: 'New', isNew: true };
  const v = Math.round((Number(delta) / p) * 100);
  return { text: `${v >= 0 ? '+' : ''}${v}%`, isNew: false };
}

export default function MoversList({ gainers = [], droppers = [], comparisonLabel = 'the prior period' }) {
  const netChange = sum(gainers, 'delta') + sum(droppers, 'delta');
  const recentTotal = sum(gainers, 'recent') + sum(droppers, 'recent');
  const priorTotal = sum(gainers, 'prior') + sum(droppers, 'prior');
  const pct = priorTotal ? Math.round((netChange / priorTotal) * 100) : null;
  const changed = gainers.length + droppers.length;

  return (
    <div className="space-y-6">
      {/* 1 ─ Summary grid */}
      <div className="card p-6">
        <div className="flex flex-col lg:flex-row items-stretch justify-between gap-6">
          <div className="lg:max-w-xs flex flex-col justify-center">
            <div className="flex items-center gap-2">
              <h3 className="text-base font-extrabold text-slate-950 tracking-tight">Query Movements</h3>
              <span className="text-slate-400 cursor-help" title="Queries that changed the most in clicks"><Info size={14} /></span>
            </div>
            <p className="text-xs text-slate-400 font-semibold mt-1">Clicks performance compared to {comparisonLabel}</p>
          </div>
          
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 flex-1">
            <Metric icon={<TrendUp />} tint={GREEN} value={fmtSigned(netChange)} label="Net click change"
              badge={pct != null ? `${pct >= 0 ? '+' : ''}${pct}%` : null} badgeUp={netChange >= 0} />
            <Metric icon={<Activity />} tint={BLUE} value={recentTotal.toLocaleString()} label="This period clicks"
              sub={`vs ${priorTotal.toLocaleString()}`} />
            <Metric icon={<Target />} tint={PURPLE} value={changed} label="Queries moved" />
            <Metric icon={<Swap />} tint={GREEN}
              value={
                <span className="flex items-center gap-1">
                  <span className="text-emerald-500 font-extrabold">{gainers.length}</span>
                  <span className="text-slate-300 font-medium">/</span>
                  <span className="text-rose-500 font-extrabold">{droppers.length}</span>
                </span>
              }
              label="Gainers / Drops" />
          </div>
        </div>
      </div>

      {/* 2 ─ AI Insights Highlights band */}
      <Highlights gainers={gainers} droppers={droppers} comparisonLabel={comparisonLabel} />

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
    <div className="rounded-2xl border border-slate-200/50 p-4 card-hover bg-white/50 backdrop-blur-md flex flex-col justify-between group">
      <div className="flex items-center justify-between">
        <span 
          className="w-8 h-8 rounded-xl grid place-items-center transition-transform duration-300 group-hover:scale-105" 
          style={{ background: `${tint}12`, color: tint }}
        >
          {icon}
        </span>
        {badge && (
          <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full border ${
            badgeUp 
              ? 'bg-emerald-500/5 text-emerald-600 border-emerald-500/10' 
              : 'bg-rose-500/5 text-rose-500 border-rose-500/10'
          }`}>
            {badge}
          </span>
        )}
      </div>
      <div className="mt-3.5">
        <div className="text-xl font-black text-slate-950 tracking-tight leading-none">{value}</div>
        <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mt-1.5">{label}</div>
        {sub && <div className="text-[10px] font-medium text-slate-400 mt-1">{sub}</div>}
      </div>
    </div>
  );
}

/* ───────── Highlights band — local heuristics over gainers/droppers, not an LLM call ───────── */
function Highlights({ gainers, droppers, comparisonLabel }) {
  const used = new Set();
  const take = (q) => { if (q) used.add(q.query); return q; };

  const topGain = take(gainers[0]);
  const newQ = take(gainers.find((g) => !used.has(g.query) && Number(g.prior) === 0));
  const vsQ = take([...gainers, ...droppers].find((q) => !used.has(q.query) && / vs /i.test(q.query)));
  const topDrop = take(droppers[0]);

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
    blocks.push({ 
      icon: <TrendUp />, 
      color: GREEN, 
      tag: 'Gainer', 
      head: `“${topGain.query}”`, 
      text: withTranslation(topGain.query, `Highest growth · ${c.isNew ? `+${topGain.recent} clicks` : `${c.text} clicks`}`),
      border: 'rgba(16,185,129,0.1)',
      bg: 'rgba(16,185,129,0.03)'
    });
  }
  if (newQ) {
    blocks.push({ 
      icon: <Sparkle />, 
      color: BLUE, 
      tag: 'New', 
      head: `“${newQ.query}”`, 
      text: withTranslation(newQ.query, newQ.page ? `+${newQ.recent} new clicks → ${newQ.page}` : `+${newQ.recent} new clicks vs ${comparisonLabel}`),
      border: 'rgba(59,130,246,0.1)',
      bg: 'rgba(59,130,246,0.03)'
    });
  }
  if (vsQ) {
    blocks.push({ 
      icon: <Activity />, 
      color: PURPLE, 
      tag: 'Trending', 
      head: `“${vsQ.query}”`, 
      text: withTranslation(vsQ.query, 'Comparison searches gaining momentum'),
      border: 'rgba(139,92,246,0.1)',
      bg: 'rgba(139,92,246,0.03)'
    });
  }
  if (topDrop) {
    blocks.push({ 
      icon: <TrendDown />, 
      color: RED, 
      tag: 'Drop', 
      head: `“${topDrop.query}”`, 
      text: withTranslation(topDrop.query, 'Lost the most visibility — refresh content'),
      border: 'rgba(244,63,94,0.1)',
      bg: 'rgba(244,63,94,0.03)'
    });
  }

  if (blocks.length === 0) return null;

  return (
    <div className="rounded-3xl border border-indigo-500/10 p-5 bg-gradient-to-br from-indigo-500/[0.02] via-purple-500/[0.01] to-white/70 backdrop-blur-md">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-xs font-black uppercase tracking-wider text-indigo-600">Spotlight Insights</span>
      </div>
      <div className="flex flex-wrap gap-4">
        {blocks.map((b, i) => (
          <div 
            key={i} 
            className="flex items-start gap-3 rounded-2xl border p-4 shadow-sm bg-white/70 hover:translate-y-[-1px] transition-transform duration-200 flex-1 min-w-[240px]"
            style={{ borderColor: b.border, background: b.bg }}
          >
            <span 
              className="w-8 h-8 rounded-xl grid place-items-center shrink-0 shadow-sm" 
              style={{ background: '#fff', color: b.color }}
            >
              {b.icon}
            </span>
            <div className="min-w-0 flex-1">
              <span 
                className="text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border" 
                style={{ borderColor: b.border, color: b.color, background: '#fff' }}
              >
                {b.tag}
              </span>
              <div className="text-sm font-bold text-slate-900 leading-snug mt-2 truncate" title={b.head}>{b.head}</div>
              <div className="text-[11px] font-medium text-slate-500 leading-snug mt-1">{b.text}</div>
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
  const soft = gain ? '#ecfdf5' : '#fff1f2';
  const softBorder = gain ? 'rgba(16,185,129,0.1)' : 'rgba(244,63,94,0.1)';
  const displayRows = showAll ? (rows || []) : (rows || []).slice(0, 7);
  const hasMore = (rows || []).length > 7;
  
  return (
    <div className="card flex flex-col justify-between">
      <div>
        <div className="flex items-center justify-between p-5 pb-3">
          <div className="flex items-center gap-3">
            <span 
              className="w-9 h-9 rounded-xl grid place-items-center text-white shadow-sm" 
              style={{ 
                background: color,
                boxShadow: `0 4px 10px -2px ${color}55`
              }}
            >
              {gain ? <TrendUp /> : <TrendDown />}
            </span>
            <h3 className="font-extrabold text-slate-950 tracking-tight">{gain ? 'Top Gainers' : 'Top Drops'}</h3>
          </div>
          <span 
            className="text-[10px] font-bold px-2.5 py-0.5 rounded-full border" 
            style={{ background: soft, borderColor: softBorder, color }}
          >
            {gain ? '▲' : '▼'} {total} queries
          </span>
        </div>

        {/* column header */}
        <div className="grid grid-cols-[28px_1fr_64px_64px_64px] items-center gap-3 px-5 pt-3 pb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400 border-b border-slate-100">
          <span></span>
          <span>Query</span>
          <span className="text-right">Change</span>
          <span className="text-right">%</span>
          <span className="text-right">Trend</span>
        </div>

        <div className="px-2 divide-y divide-slate-100/50">
          {displayRows.length === 0 && <div className="text-sm text-slate-400 px-3 py-6 font-medium">No movement.</div>}
          {displayRows.map((r, i) => {
            const c = changePct(r.prior, r.delta);
            return (
              <div key={i} className="grid grid-cols-[28px_1fr_64px_64px_64px] items-center gap-3 px-3 py-3 rounded-xl hover:bg-slate-50/50 transition duration-150 group">
                <span 
                  className="w-5 h-5 rounded-md grid place-items-center text-[10px] font-black" 
                  style={{ background: soft, color }}
                >
                  {i + 1}
                </span>
                <span className="min-w-0 pr-1">
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className="text-sm font-semibold text-slate-700 truncate group-hover:text-slate-900 transition-colors" title={r.query}>
                      {r.query}
                    </span>
                    <TranslateButton query={r.query} />
                  </span>
                  {r.page && (
                    <span className="block text-[10px] text-slate-400 font-medium truncate mt-0.5" title={r.page}>
                      → {r.page.replace(/https?:\/\/[^\/]+/i, '')}{(r.device || r.country) && ` (${[r.device?.toLowerCase(), r.country].filter(Boolean).join(' · ')})`}
                    </span>
                  )}
                </span>
                <span className="text-right text-sm font-bold tabular-nums" style={{ color }}>{fmtSigned(r.delta)}</span>
                <span className="text-right">
                  <span 
                    className="text-[10px] font-bold px-1.5 py-0.5 rounded border"
                    style={c.isNew 
                      ? { background: '#eff6ff', borderColor: 'rgba(59,130,246,0.1)', color: '#2563eb' } 
                      : { background: soft, borderColor: softBorder, color }}
                  >
                    {c.text}
                  </span>
                </span>
                <span className="flex justify-end pr-1">
                  <Sparkline data={sparkSteps(r.prior, r.recent)} color={color} width={50} height={18} fill={false} dot={false} />
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {hasMore && (
        <button 
          className="w-[calc(100%-16px)] text-xs font-bold py-2.5 mx-2 my-2 rounded-xl transition duration-150 border hover:brightness-95 select-none"
          style={{ background: soft, borderColor: softBorder, color }}
          onClick={() => setShowAll((s) => !s)}
        >
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
          className="text-[10px] text-slate-400 hover:text-slate-650 leading-none transition-colors"
          title="Translate query"
          onClick={async (e) => {
            e.stopPropagation();
            setState('loading');
            try { setState(await api.translate(query)); }
            catch { setState({ language: 'unknown', translation: '' }); }
          }}
        >🌐</button>
      )}
      {state === 'loading' && <span className="text-[10px] text-slate-350 animate-pulse">…</span>}
      {state && state !== 'loading' && state.translation && (
        <span className="text-[10px] text-indigo-500 italic font-semibold" title={state.language}> “{state.translation}”</span>
      )}
    </span>
  );
}

function sparkSteps(from, to) {
  const a = Number(from) || 0, b = Number(to) || 0;
  return [a, a + (b - a) * 0.2, a + (b - a) * 0.45, a + (b - a) * 0.62, a + (b - a) * 0.82, b];
}

const S = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round', strokeLinejoin: 'round' };
const TrendUp = () => (<svg {...S}><polyline points="22 7 13.5 15.5 8.5 10.5 2 17" /><polyline points="16 7 22 7 22 13" /></svg>);
const TrendDown = () => (<svg {...S}><polyline points="22 17 13.5 8.5 8.5 13.5 2 7" /><polyline points="16 17 22 17 22 11" /></svg>);
const Activity = () => (<svg {...S}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>);
const Target = () => (<svg {...S}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></svg>);
const Swap = () => (<svg {...S}><polyline points="17 4 21 8 17 12" /><path d="M21 8H7" /><polyline points="7 20 3 16 7 12" /><path d="M3 16h14" /></svg>);
const Sparkle = () => (<svg {...S}><path d="M12 3v4M12 17v4M5 12H1M23 12h-4M6 6l2 2M16 16l2 2M18 6l-2 2M8 16l-2 2" /></svg>);

