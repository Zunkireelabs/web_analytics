import { useCountUp } from '../useCountUp.js';
import { timeAgo } from '../api.js';
import { AlertTriangle, Network } from 'lucide-react';

// Free, Common Crawl-derived referring-domain count — a separate, clearly
// distinct widget from AuthorityScoreCard.jsx (DataForSEO-backed). Never
// merged into that card's props/state/markup, and styled with a different
// accent (teal, not Authority's indigo #6C63FF) so the two are never
// mistaken for the same metric. See server/routes/commoncrawl-backlinks.js
// for the API contract this renders.

function emptyMessage(summary) {
  if (summary?.message) return summary.message;
  return "Could not resolve this site's own domain yet — no real page data to derive it from.";
}

export default function ReferringDomainsCard({ summary, loading }) {
  const animatedCount = useCountUp(summary?.referringDomains ?? 0);

  if (loading) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm animate-pulse h-[140px] flex flex-col justify-between">
        <div className="space-y-3">
          <div className="h-3 w-32 bg-slate-100 rounded" />
          <div className="h-8 w-16 bg-slate-200 rounded" />
        </div>
        <div className="h-4 w-2/3 bg-slate-50 rounded" />
      </div>
    );
  }

  if (!summary || summary.status !== 'ok') {
    return (
      <div className="relative overflow-hidden card bg-gradient-to-br from-teal-50/70 via-emerald-50/30 to-white border border-teal-150 p-5 flex items-start gap-3.5 shadow-2xs hover:shadow-md hover:border-teal-300 transition-all duration-300 min-h-[140px]">
        <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-teal-500 to-emerald-500" />
        <div className="absolute -right-8 -bottom-8 w-24 h-24 rounded-full blur-2xl opacity-40 bg-teal-200" />

        <span className="w-9 h-9 rounded-2xl grid place-items-center bg-teal-100/80 text-teal-600 border border-teal-200/60 shrink-0 shadow-2xs mt-0.5">
          <Network size={18} strokeWidth={2.25} />
        </span>
        <div className="min-w-0 flex-1 relative z-10 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-black text-teal-950 text-[11px] uppercase tracking-wider">Referring Domains</span>
          </div>
          <p className="text-[11.5px] leading-relaxed text-slate-600 font-semibold">
            {emptyMessage(summary)}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-3xl border border-slate-200 bg-white shadow-sm p-6 hover:shadow-md transition-all duration-300">
      <div className="flex items-start justify-between gap-6">
        <div className="space-y-1">
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
            <Network size={12} className="text-teal-600" />
            <span>Referring Domains</span>
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-4xl font-black tracking-tight text-slate-900 tabular-nums">{animatedCount}</span>
            <span className="text-xs font-bold text-slate-400">domains</span>
          </div>
        </div>
      </div>

      <div className="mt-4 pt-4 border-t border-slate-100">
        <div className="text-[9px] font-black uppercase tracking-widest text-slate-400">Last Checked</div>
        <div className="text-xs font-bold text-slate-700 mt-1">{timeAgo(summary.updatedAt)}</div>
      </div>
    </div>
  );
}
