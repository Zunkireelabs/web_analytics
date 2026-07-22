import { useState } from 'react';
import { useCountUp } from '../useCountUp.js';
import { timeAgo } from '../api.js';
import Sparkline from './Sparkline.jsx';
import { AlertTriangle, Award, Link2, Info, ArrowUpRight, ArrowDownRight } from 'lucide-react';

function emptyMessage(meta) {
  if (!meta?.dataForSeoBacklinksConfigured) return 'DataForSEO not configured, and no Common Crawl data imported for this domain yet — run npm run refresh-commoncrawl-graph for a coarser free estimate, or connect DataForSEO for the full score.';
  if (!meta?.hasRun) return 'Not analyzed yet — runs monthly.';
  if (meta.status === 'error') return 'Last run failed — check Integration Health below.';
  if (meta.status === 'insufficient-data') return `Last run (${timeAgo(meta.lastRunAt)}) had no usable backlink data for this domain yet.`;
  return `Last run (${timeAgo(meta.lastRunAt)}) completed but returned no score.`;
}

const scoreColor = (score) => (score >= 70 ? '#10b981' : score >= 40 ? '#f59e0b' : '#ef4444');

export default function AuthorityScoreCard({ authority, meta, loading }) {
  const [showPages, setShowPages] = useState(false);
  const animatedScore = useCountUp(authority?.score ?? 0, 900);

  if (loading) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm animate-pulse h-[180px] flex flex-col justify-between">
        <div className="space-y-3">
          <div className="h-3 w-28 bg-slate-100 rounded" />
          <div className="h-8 w-20 bg-slate-200 rounded" />
        </div>
        <div className="h-4 w-full bg-slate-50 rounded" />
      </div>
    );
  }

  if (!authority) {
    return (
      <div className="relative overflow-hidden card bg-gradient-to-br from-indigo-50/70 via-purple-50/30 to-white border border-indigo-150 p-5 flex items-start gap-3.5 shadow-2xs hover:shadow-md hover:border-indigo-300 transition-all duration-300 min-h-[140px]">
        <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-indigo-500 to-purple-500" />
        <div className="absolute -right-8 -bottom-8 w-24 h-24 rounded-full blur-2xl opacity-40 bg-indigo-200" />

        <span className="w-9 h-9 rounded-2xl grid place-items-center bg-indigo-100/80 text-indigo-600 border border-indigo-200/60 shrink-0 shadow-2xs mt-0.5">
          <Award size={18} strokeWidth={2.25} />
        </span>
        <div className="min-w-0 flex-1 relative z-10 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-black text-indigo-950 text-[11px] uppercase tracking-wider">SEO Domain Authority</span>
            <span className="text-[9px] font-black uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200/80 shadow-2xs">
              Pending Setup
            </span>
          </div>
          <p className="text-[11.5px] leading-relaxed text-slate-600 font-semibold">
            {emptyMessage(meta)}
          </p>
        </div>
      </div>
    );
  }

  const trendGood = authority.scoreDelta == null ? null : authority.scoreDelta >= 0;
  const topReasons = [...(authority.breakdown || [])].sort((a, b) => b.normalizedWeightPct - a.normalizedWeightPct).slice(0, 3);
  const history = (authority.history || []).map((h) => h.score);

  return (
    <div className="rounded-3xl border border-slate-200 bg-white shadow-sm p-6 hover:shadow-md transition-all duration-300">
      {/* Top Main Score Segment */}
      <div className="flex items-start justify-between gap-6">
        <div className="space-y-1">
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
            <Award size={12} className="text-[#6C63FF]" />
            <span>SEO Domain Authority</span>
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-4xl font-black tracking-tight text-slate-900 tabular-nums">{animatedScore}</span>
            <span className="text-xs font-bold text-slate-400">/100</span>
          </div>
          {authority.dataSource === 'commoncrawl' && (
            <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full border text-amber-700 bg-amber-50 border-amber-100">
              <Info size={10} strokeWidth={3} /> Coarse estimate — referring domains only
            </span>
          )}
          {authority.scoreDelta != null && authority.scoreDelta !== 0 && (
            <span className={`inline-flex items-center gap-0.5 text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full mt-2 border ${
              trendGood 
                ? 'text-emerald-700 bg-emerald-50 border-emerald-100' 
                : 'text-rose-600 bg-rose-50 border-rose-100'
            }`}>
              {trendGood ? <ArrowUpRight size={10} strokeWidth={3} /> : <ArrowDownRight size={10} strokeWidth={3} />}
              {Math.abs(authority.scoreDelta)} pt{Math.abs(authority.scoreDelta) === 1 ? '' : 's'} delta
            </span>
          )}
        </div>
        {history.length >= 2 && (
          <div className="w-24 h-12 shrink-0 bg-slate-50/50 rounded-xl p-1.5 border border-slate-100">
            <Sparkline data={history} color={scoreColor(authority.score)} stretch dot={false} />
          </div>
        )}
      </div>

      {/* Collapsed view reasons summary list */}
      {!showPages && topReasons.length > 0 && (
        <div className="mt-4 pt-4 border-t border-slate-100 space-y-2.5 animate-fade-in">
          <div className="text-[9px] font-black uppercase tracking-widest text-slate-400">Authority Breakdown Signals</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {topReasons.map((r) => (
              <div key={r.key} className="bg-slate-50/60 border border-slate-150 rounded-xl p-2.5 flex flex-col justify-between">
                <span className="text-[10px] font-bold text-slate-500 truncate leading-snug">{r.label}</span>
                <span className="text-[11px] font-black mt-1 tabular-nums" style={{ color: scoreColor(r.score) }}>
                  {Math.round(r.score)}/100
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Drawer Open Grid Section (Evenly Distributed Left and Right) */}
      {authority.topLinkedPages?.length > 0 && (
        <div className="mt-4 pt-4 border-t border-slate-100">
          <button 
            type="button" 
            onClick={() => setShowPages((s) => !s)}
            className="text-[10px] font-black uppercase tracking-wider text-[#6C63FF] hover:underline flex items-center gap-1 py-2 focus:outline-none"
          >
            {showPages ? 'Hide detailed authority analysis ↑' : `Show detailed authority analysis (${authority.topLinkedPages.length}) ↓`}
          </button>
          
          {showPages && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-4 pt-4 border-t border-slate-100/70 items-stretch animate-slide-down">
              {/* Left Column: Breakdown details */}
              <div className="space-y-3 flex flex-col">
                <div className="text-[9px] font-black uppercase tracking-widest text-slate-400">Authority Signal Composition</div>
                <div className="space-y-2 flex-1">
                  {authority.breakdown?.map((r) => (
                    <div key={r.key} className="bg-slate-50/50 border border-slate-150 rounded-xl p-3 flex items-center justify-between gap-3">
                      <div>
                        <div className="text-xs font-bold text-slate-800 leading-tight">{r.label}</div>
                        <div className="text-[9px] text-slate-400 font-semibold mt-0.5">{r.normalizedWeightPct}% influence weight</div>
                      </div>
                      <span className="text-xs font-black tabular-nums" style={{ color: scoreColor(r.score) }}>
                        {Math.round(r.score)}/100
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Right Column: Top Linked Pages */}
              <div className="space-y-3 flex flex-col">
                <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1">
                  <Link2 size={11} className="text-[#6C63FF]" />
                  <span>Top Linked Domain Entry Pages</span>
                </div>
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-3.5 space-y-2 flex-1 flex flex-col justify-between">
                  <div className="space-y-2">
                    {authority.topLinkedPages.slice(0, 5).map((p, i) => (
                      <div key={i} className="flex justify-between items-center text-[10px] font-mono leading-tight">
                        <span className="text-slate-400 truncate max-w-[120px] sm:max-w-[170px]" title={p.page}>{p.page}</span>
                        <span className="text-emerald-400 font-bold shrink-0">{p.referringDomain} domains</span>
                      </div>
                    ))}
                  </div>
                  <div className="text-[8px] font-semibold text-slate-500 border-t border-slate-800/80 pt-2 text-right">
                    Showing top {Math.min(5, authority.topLinkedPages.length)} referral metrics
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
