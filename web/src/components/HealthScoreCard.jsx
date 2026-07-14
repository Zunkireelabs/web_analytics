import { useCountUp } from '../useCountUp.js';

// The composite Website Health score (server/agents/lib/health-score.js) —
// weighted, deduped across every specialist agent's findings. Shown with its
// week-over-week trend so a number never appears without its direction.
export default function HealthScoreCard({ score, trendWeek, loading }) {
  const animatedScore = useCountUp(score, 900);

  if (loading) {
    return (
      <div className="p-6 h-full flex flex-col justify-center gap-3">
        <div className="h-3 w-28 bg-slate-100 rounded animate-pulse" />
        <div className="h-11 w-20 bg-slate-200 rounded animate-pulse" />
        <div className="h-5 w-32 bg-slate-100 rounded-full animate-pulse" />
      </div>
    );
  }

  const trendGood = trendWeek == null ? null : trendWeek >= 0;

  return (
    <div className="p-6 h-full flex flex-col justify-center gap-3.5">
      <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Website Health</div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-5xl font-extrabold tracking-tight text-slate-900 tabular-nums">{animatedScore}</span>
        <span className="text-sm font-semibold text-slate-400">/ 100</span>
      </div>
      {trendWeek != null && trendWeek !== 0 && (
        <span className={`inline-flex items-center gap-1 w-fit text-xs font-semibold px-2.5 py-1 rounded-full ${
          trendGood ? 'text-emerald-700 bg-emerald-50' : 'text-rose-600 bg-rose-50'
        }`}>
          {trendGood ? '↑' : '↓'} {Math.abs(trendWeek)} pt{Math.abs(trendWeek) === 1 ? '' : 's'} this week
        </span>
      )}
      <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(0, Math.min(100, score))}%`, background: '#6C63FF' }} />
      </div>
      <div className="text-[11px] text-slate-400 leading-relaxed">
        Weighted across SEO, technical, content &amp; AI visibility — same real findings shown below.
      </div>
    </div>
  );
}
