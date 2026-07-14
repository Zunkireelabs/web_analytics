import { useState } from 'react';
import { useCountUp } from '../useCountUp.js';
import { timeAgo } from '../api.js';
import Sparkline from './Sparkline.jsx';

// Three honestly different reasons this card can have nothing to show —
// same discipline as CommandCenter.jsx's competitorEmptyMessage: "not
// configured" (no real DataForSEO Backlinks credentials) must never read
// the same as "ran, found nothing" or "not yet run."
function emptyMessage(meta) {
  if (!meta?.dataForSeoBacklinksConfigured) return 'Not configured — needs a real DataForSEO Backlinks API connection (DATAFORSEO_LOGIN/PASSWORD) to compute a real score.';
  if (!meta?.hasRun) return 'Not analyzed yet — runs monthly.';
  if (meta.status === 'error') return 'Last run failed — check Integration Health below.';
  if (meta.status === 'insufficient-data') return `Last run (${timeAgo(meta.lastRunAt)}) had no usable backlink data for this domain yet.`;
  return `Last run (${timeAgo(meta.lastRunAt)}) completed but returned no score.`;
}

const scoreColor = (score) => (score >= 70 ? '#16A34A' : score >= 40 ? '#f59e0b' : '#EF4444');

// Real, computed (server/agents/lib/authority-score.js), never a random or
// estimated value — a proprietary weighted score over real DataForSEO
// backlink data, explicitly NOT Ahrefs DR or Moz DA. The breakdown below is
// the literal "why the score changed" data, diffed in JS against the prior
// real snapshot, never asked of an LLM to compute.
export default function AuthorityScoreCard({ authority, meta, loading }) {
  const [showPages, setShowPages] = useState(false);
  const animatedScore = useCountUp(authority?.score ?? 0, 900);

  if (loading) {
    return (
      <div className="card p-6 h-full flex flex-col justify-center gap-3">
        <div className="h-3 w-28 bg-slate-100 rounded animate-pulse" />
        <div className="h-11 w-20 bg-slate-200 rounded animate-pulse" />
        <div className="h-5 w-32 bg-slate-100 rounded-full animate-pulse" />
      </div>
    );
  }

  if (!authority) {
    return <div className="card p-8 text-center text-sm text-slate-400">{emptyMessage(meta)}</div>;
  }

  const trendGood = authority.scoreDelta == null ? null : authority.scoreDelta >= 0;
  const topReasons = [...(authority.breakdown || [])].sort((a, b) => b.normalizedWeightPct - a.normalizedWeightPct).slice(0, 3);
  const history = (authority.history || []).map((h) => h.score);

  return (
    <div className="card p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1">Authority Score</div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-4xl font-extrabold tracking-tight text-slate-900 tabular-nums">{animatedScore}</span>
            <span className="text-sm font-semibold text-slate-400">/ 100</span>
          </div>
          {authority.scoreDelta != null && authority.scoreDelta !== 0 && (
            <span className={`inline-flex items-center gap-1 w-fit text-xs font-semibold px-2.5 py-1 rounded-full mt-2 ${
              trendGood ? 'text-emerald-700 bg-emerald-50' : 'text-rose-600 bg-rose-50'
            }`}>
              {trendGood ? '↑' : '↓'} {Math.abs(authority.scoreDelta)} pt{Math.abs(authority.scoreDelta) === 1 ? '' : 's'} since last check
            </span>
          )}
        </div>
        {history.length >= 2 && (
          <div className="w-24 h-10 shrink-0">
            <Sparkline data={history} color={scoreColor(authority.score)} stretch dot={false} />
          </div>
        )}
      </div>

      {topReasons.length > 0 && (
        <div className="mt-4 pt-4 border-t border-slate-50 space-y-1.5">
          <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">Real signals behind this score</div>
          {topReasons.map((r) => (
            <div key={r.key} className="flex items-center justify-between text-xs">
              <span className="text-slate-600">{r.label}</span>
              <span className="font-semibold tabular-nums" style={{ color: scoreColor(r.score) }}>{Math.round(r.score)}/100 · {r.normalizedWeightPct}% weight</span>
            </div>
          ))}
        </div>
      )}

      {authority.topLinkedPages?.length > 0 && (
        <div className="mt-3 pt-3 border-t border-slate-50">
          <button type="button" onClick={() => setShowPages((s) => !s)}
            className="text-[11px] font-semibold text-slate-400 hover:text-[#6C63FF] transition-colors">
            {showPages ? 'Hide top linked pages ↑' : `Show top linked pages (${authority.topLinkedPages.length}) →`}
          </button>
          {showPages && (
            <ul className="mt-2 space-y-1 fade-up">
              {authority.topLinkedPages.slice(0, 8).map((p, i) => (
                <li key={i} className="flex justify-between gap-2 text-[11px] text-slate-500">
                  <span className="truncate">{p.page}</span>
                  <span className="shrink-0 text-slate-400">{p.referringDomain}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
