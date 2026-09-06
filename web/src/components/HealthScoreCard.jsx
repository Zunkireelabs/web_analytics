import { useCountUp } from '../useCountUp.js';

export default function HealthScoreCard({ score, trendWeek, loading }) {
  const animatedScore = useCountUp(score, 900);

  if (loading) {
    return (
      <div className="p-6 h-full flex flex-col justify-center items-center gap-3">
        <div className="h-3 w-28 bg-slate-100 rounded animate-pulse" />
        <div className="w-20 h-20 rounded-full border-4 border-slate-100 border-t-slate-350 animate-spin" />
        <div className="h-5 w-32 bg-slate-100 rounded-full animate-pulse" />
      </div>
    );
  }

  const trendGood = trendWeek == null ? null : trendWeek >= 0;

  // Radial Circle Gauge Constants
  const radius = 36;
  const strokeWidth = 8;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (Math.min(100, Math.max(0, score)) / 100) * circumference;

  return (
    <div className="p-4 h-full flex flex-col sm:flex-row items-center justify-between gap-6 text-slate-800 bg-white">
      
      {/* Left side labels */}
      <div className="space-y-3.5 flex-1 text-center sm:text-left">
        <div className="text-[11px] font-black uppercase tracking-wider text-slate-400">Website Health Score</div>
        
        <div className="flex items-baseline justify-center sm:justify-start gap-1">
          <span className="text-4xl font-extrabold tracking-tight text-slate-900 tabular-nums">{animatedScore}</span>
          <span className="text-xs font-bold text-slate-400">/ 100</span>
        </div>

        {trendWeek != null && trendWeek !== 0 && (
          <span className={`inline-flex items-center gap-1 text-[10.5px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full border ${
            trendGood 
              ? 'text-emerald-700 bg-emerald-50 border-emerald-100' 
              : 'text-rose-600 bg-rose-50 border-rose-100'
          }`}>
            {trendGood ? '▲' : '▼'} {Math.abs(trendWeek)} pt{Math.abs(trendWeek) === 1 ? '' : 's'} this week
          </span>
        )}

        <div className="text-[10px] text-slate-450 leading-relaxed font-bold hidden sm:block">
          Weighted across SEO, technical, content &amp; AI visibility.
        </div>
      </div>

      {/* Right side circular SVG gauge */}
      <div className="relative shrink-0 w-24 h-24 flex items-center justify-center">
        <svg className="w-full h-full transform -rotate-90" viewBox="0 0 96 96">
          {/* Background circle track */}
          <circle
            cx="48"
            cy="48"
            r={radius}
            fill="transparent"
            stroke="#f1f5f9"
            strokeWidth={strokeWidth}
          />
          {/* Progress circle bar */}
          <circle
            cx="48"
            cy="48"
            r={radius}
            fill="transparent"
            stroke="url(#healthGaugeGrad)"
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            className="transition-all duration-1000 ease-out"
          />
          <defs>
            <linearGradient id="healthGaugeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#6C63FF" />
              <stop offset="100%" stopColor="#8b5cf6" />
            </linearGradient>
          </defs>
        </svg>
        {/* Inner text inside circle */}
        <div className="absolute inset-0 flex items-center justify-center flex-col">
          <span className="text-[15px] font-black text-slate-900 leading-none">{score}</span>
          <span className="text-[8px] font-bold text-slate-450 uppercase tracking-wide mt-0.5">health</span>
        </div>
      </div>
      
    </div>
  );
}
