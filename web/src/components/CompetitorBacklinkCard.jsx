import { timeAgo } from '../api.js';
import { AlertTriangle, Network } from 'lucide-react';

// Free Common Crawl referring-domain comparison vs. tracked competitors
// (server/agents/lib/competitor-backlinks.js). Distinct from
// ReferringDomainsCard.jsx (this site's own summary) and from
// AuthorityScoreCard.jsx (DataForSEO-backed) — never merged with either.
// Same teal "Common Crawl" visual language as ReferringDomainsCard so the
// two read as one family of free-data cards.

function emptyMessage(meta) {
  if (!meta?.hasRun) return "We haven't compared backlinks yet.";
  return meta.message || 'No backlink comparison available yet.';
}

export default function CompetitorBacklinkCard({ backlinkComparison, meta, loading }) {
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

  if (!backlinkComparison) {
    return (
      <div className="relative overflow-hidden card bg-gradient-to-br from-cyan-50/70 via-sky-50/30 to-white border border-cyan-150 p-5 flex items-start gap-3.5 shadow-2xs hover:shadow-md hover:border-cyan-300 transition-all duration-300 min-h-[140px]">
        <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-cyan-500 to-sky-500" />
        <div className="absolute -right-8 -bottom-8 w-24 h-24 rounded-full blur-2xl opacity-40 bg-cyan-200" />

        <span className="w-9 h-9 rounded-2xl grid place-items-center bg-cyan-100/80 text-cyan-600 border border-cyan-200/60 shrink-0 shadow-2xs mt-0.5">
          <Network size={18} strokeWidth={2.25} />
        </span>
        <div className="min-w-0 flex-1 relative z-10 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-black text-cyan-950 text-[11px] uppercase tracking-wider">Competitor Backlink Comparison</span>
          </div>
          <p className="text-[11.5px] leading-relaxed text-slate-600 font-semibold">
            {emptyMessage(meta)}
          </p>
        </div>
      </div>
    );
  }

  const { ownDomain, strongestProfile, largestGap, opportunities } = backlinkComparison;
  const leaderIsOwn = strongestProfile?.domain === ownDomain?.domain;

  return (
    <div className="rounded-3xl border border-slate-200 bg-white shadow-sm p-6 hover:shadow-md transition-all duration-300">
      <div className="flex items-start justify-between gap-6">
        <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
          <Network size={12} className="text-teal-600" />
          <span>Competitor Backlink Comparison</span>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="bg-slate-50/60 border border-slate-150 rounded-xl p-3">
          <div className="text-[9px] font-black uppercase tracking-widest text-slate-400">You</div>
          <div className="text-lg font-black tracking-tight text-slate-900 tabular-nums mt-0.5">{ownDomain.referringDomains}</div>
          <div className="text-[9px] text-slate-450 font-semibold">referring domains</div>
        </div>
        <div className="bg-slate-50/60 border border-slate-150 rounded-xl p-3">
          <div className="text-[9px] font-black uppercase tracking-widest text-slate-400">Strongest Profile</div>
          <div className="text-sm font-black text-slate-900 truncate mt-0.5" title={strongestProfile.domain}>
            {leaderIsOwn ? 'This site' : strongestProfile.domain}
          </div>
          <div className="text-[9px] text-slate-450 font-semibold">{strongestProfile.referringDomains} referring domains</div>
        </div>
      </div>

      {largestGap ? (
        <div className="mt-3 pt-3 border-t border-slate-100 space-y-2">
          <div className="text-[9px] font-black uppercase tracking-widest text-slate-400">Largest Gap</div>
          <p className="text-xs text-slate-700 font-semibold leading-relaxed">
            <span className="font-black text-rose-600">{largestGap.domain}</span> has{' '}
            <span className="font-black">{largestGap.gap}</span> more referring domain{largestGap.gap === 1 ? '' : 's'} than you.
          </p>
          {opportunities?.length > 0 && (
            <div className="space-y-1">
              <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 mt-2">Opportunities</div>
              {opportunities.map((o) => (
                <p key={o.domain} className="text-[11px] text-slate-600 font-medium leading-relaxed">
                  Catch up to <span className="font-bold">{o.domain}</span> — only {o.gap} referring domain{o.gap === 1 ? '' : 's'} behind.
                </p>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="mt-3 pt-3 border-t border-slate-100">
          <p className="text-xs text-emerald-700 font-bold">You lead every tracked competitor here.</p>
        </div>
      )}

      <div className="mt-3 text-[9px] text-slate-400 font-semibold">Updated {timeAgo(ownDomain.updatedAt)}</div>
    </div>
  );
}
