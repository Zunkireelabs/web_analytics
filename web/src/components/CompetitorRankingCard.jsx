import { AlertTriangle, CheckCircle2, Search, ArrowUpRight, ArrowDownRight } from 'lucide-react';

// Real Google-SERP "who outranks you" comparison (server/agents/competitor-
// intelligence.js's rankingComparison) — deliberately never a 0-100 score,
// only real query/domain/position/impressions facts. Distinct from
// CompetitorLeaderboard.jsx (structural/AI-readiness score) and from
// CompetitorBacklinkCard.jsx/ReferringDomainsCard.jsx (Common Crawl) — a
// sky-blue accent keeps all three "how do we compare" families visually
// distinct at a glance.

const SOURCE_LABEL = { dataforseo: 'Live Search Data', 'google-cse': 'Google Search' };

function AmberState({ title, message }) {
  return (
    <div className="relative overflow-hidden card bg-gradient-to-br from-sky-50/70 via-blue-50/30 to-white border border-sky-150 p-5 flex items-start gap-3.5 shadow-2xs hover:shadow-md hover:border-sky-300 transition-all duration-300 min-h-[140px]">
      <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-sky-500 to-blue-500" />
      <div className="absolute -right-8 -bottom-8 w-24 h-24 rounded-full blur-2xl opacity-40 bg-sky-200" />

      <span className="w-9 h-9 rounded-2xl grid place-items-center bg-sky-100/80 text-sky-600 border border-sky-200/60 shrink-0 shadow-2xs mt-0.5">
        <Search size={18} strokeWidth={2.25} />
      </span>
      <div className="min-w-0 flex-1 relative z-10 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="font-black text-sky-950 text-[11px] uppercase tracking-wider">{title}</span>
          <span className="text-[9px] font-black uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-sky-100 text-sky-800 border border-sky-200/80 shadow-2xs">
            Google Search
          </span>
        </div>
        <p className="text-[11.5px] leading-relaxed text-slate-600 font-semibold">{message}</p>
      </div>
    </div>
  );
}

export default function CompetitorRankingCard({ rankingComparison, meta, loading }) {
  if (loading) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm animate-pulse h-[160px] flex flex-col justify-between">
        <div className="space-y-3">
          <div className="h-3 w-40 bg-slate-100 rounded" />
          <div className="h-6 w-32 bg-slate-200 rounded" />
        </div>
        <div className="h-4 w-2/3 bg-slate-50 rounded" />
      </div>
    );
  }

  if (!meta?.hasRun || !rankingComparison) {
    return <AmberState title="Who Outranks You (Google Search)" message="We haven't checked this yet — check back soon." />;
  }

  if (!rankingComparison.serpProviderConfigured) {
    return <AmberState title="Who Outranks You (Google Search)" message={rankingComparison.message} />;
  }

  if (!rankingComparison.checked) {
    return <AmberState title="Who Outranks You (Google Search)" message={rankingComparison.message} />;
  }

  const sourceLabel = SOURCE_LABEL[rankingComparison.source] || rankingComparison.source;

  if (!rankingComparison.rows?.length) {
    return (
      <div className="relative overflow-hidden card bg-gradient-to-br from-white to-emerald-50/20 border border-emerald-200/60 p-6 flex items-start gap-4 shadow-sm hover:shadow-md transition-all duration-300 min-h-[130px]">
        <div className="absolute left-0 inset-y-0 w-1 bg-gradient-to-b from-emerald-400 to-emerald-600" />
        <span className="w-9 h-9 rounded-2xl grid place-items-center bg-emerald-50 text-emerald-600 border border-emerald-100/80 shrink-0 shadow-inner">
          <CheckCircle2 size={16} strokeWidth={2.25} />
        </span>
        <div className="min-w-0 flex-1 relative z-10">
          <span className="font-black text-emerald-800 block text-[10px] uppercase tracking-wider mb-1 leading-none">Who Outranks You (Google Search)</span>
          <p className="text-[11.5px] leading-relaxed text-slate-505 font-bold">
            You currently outrank every tracked competitor on your top real search queries — via {sourceLabel}.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-3xl border border-slate-200 bg-white shadow-sm p-6 hover:shadow-md transition-all duration-300">
      <div className="flex items-start justify-between gap-6">
        <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
          <Search size={12} className="text-sky-600" />
          <span>Who Outranks You (Google Search)</span>
        </div>
        <span className="text-[9px] font-black uppercase tracking-wider px-2 py-1 rounded-full border text-sky-700 bg-sky-50 border-sky-100 whitespace-nowrap">
          {sourceLabel}
        </span>
      </div>

      <div className="mt-4 space-y-2">
        {rankingComparison.rows.slice(0, 5).map((r) => (
          <div key={`${r.query}:${r.competitorDomain}`} className="bg-slate-50/60 border border-slate-150 rounded-xl p-3 flex items-center gap-3">
            <span className="w-9 h-9 rounded-xl grid place-items-center text-[11px] font-bold shrink-0 bg-rose-50 text-rose-600">
              #{r.competitorPosition}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-bold text-slate-800 truncate">{r.competitorDomain}</div>
              <div className="text-[10px] text-slate-450 font-semibold truncate">
                "{r.query}" — {r.ownPosition == null ? 'you\'re not in the top 20' : `vs your #${r.ownPosition}`} · {r.impressions} impressions
              </div>
            </div>
            {r.trend != null && r.trend !== 0 && (
              <span className={`flex items-center gap-0.5 text-[9px] font-black shrink-0 ${r.trend > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                {r.trend > 0 ? <ArrowUpRight size={11} strokeWidth={3} /> : <ArrowDownRight size={11} strokeWidth={3} />}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
