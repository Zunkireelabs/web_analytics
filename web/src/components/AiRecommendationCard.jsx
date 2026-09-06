import { useState } from 'react';
import { useCountUp } from '../useCountUp.js';
import { timeAgo } from '../api.js';
import Sparkline from './Sparkline.jsx';
import { AlertTriangle, Sparkles, HelpCircle, CheckCircle2, ArrowUpRight, ArrowDownRight } from 'lucide-react';

function emptyMessage(meta) {
  const anyConfigured = meta?.providers?.some((p) => p.configured);
  if (!anyConfigured) return "We haven't set this up yet — check back soon.";
  if (!meta?.hasRun) return 'Not checked yet — this updates monthly.';
  if (meta.status === 'error') return "We couldn't check this — see Data Connection below.";
  if (meta.status === 'insufficient-data') return `Checked ${timeAgo(meta.lastRunAt)}, but there wasn't enough data yet.`;
  return `Checked ${timeAgo(meta.lastRunAt)}, but no data was available.`;
}

const pctColor = (pct) => (pct >= 60 ? '#10b981' : pct >= 25 ? '#f59e0b' : '#ef4444');

export default function AiRecommendationCard({ aiRecommendation, meta, loading }) {
  const [showPrompts, setShowPrompts] = useState(false);
  const animatedPct = useCountUp(aiRecommendation?.visibilityPct ?? 0, 900);

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

  if (!aiRecommendation) {
    return (
      <div className="relative overflow-hidden card bg-gradient-to-br from-teal-50/70 via-emerald-50/30 to-white border border-teal-150 p-5 flex items-start gap-3.5 shadow-2xs hover:shadow-md hover:border-teal-300 transition-all duration-300 min-h-[140px]">
        <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-teal-500 to-emerald-500" />
        <div className="absolute -right-8 -bottom-8 w-24 h-24 rounded-full blur-2xl opacity-40 bg-teal-200" />

        <span className="w-9 h-9 rounded-2xl grid place-items-center bg-teal-100/80 text-teal-600 border border-teal-200/60 shrink-0 shadow-2xs mt-0.5">
          <Sparkles size={18} strokeWidth={2.25} />
        </span>
        <div className="min-w-0 flex-1 relative z-10 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-black text-teal-950 text-[11px] uppercase tracking-wider">AI Search Visibility</span>
            <span className="text-[9px] font-black uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200/80 shadow-2xs">
              Not Yet Available
            </span>
          </div>
          <p className="text-[11.5px] leading-relaxed text-slate-600 font-semibold">
            {emptyMessage(meta)}
          </p>
        </div>
      </div>
    );
  }

  const history = (aiRecommendation.history || []).map((h) => h.pct).filter((v) => v != null);
  const promptCount = (aiRecommendation.topPrompts?.length || 0) + (aiRecommendation.missedPrompts?.length || 0);

  return (
    <div className="rounded-3xl border border-slate-200 bg-white shadow-sm p-6 hover:shadow-md transition-all duration-300">
      {/* Top Main Score Segment */}
      <div className="flex items-start justify-between gap-6">
        <div className="space-y-1">
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
            <Sparkles size={12} className="text-[#14b8a6]" />
            <span>AI Search Visibility</span>
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-4xl font-black tracking-tight text-slate-900 tabular-nums">{animatedPct}</span>
            <span className="text-xs font-bold text-slate-400">% visibility</span>
          </div>
          <div className="text-[10.5px] font-semibold text-slate-500 mt-2">
            Mentioned in <span className="text-indigo-650 font-bold">{aiRecommendation.mentionedCount}</span> of <span className="text-slate-800 font-bold">{aiRecommendation.promptsChecked}</span> {aiRecommendation.providerCount > 1 ? 'AI' : 'ChatGPT'} buyer-intent prompts
          </div>
        </div>
        {history.length >= 2 && (
          <div className="w-24 h-12 shrink-0 bg-slate-50/50 rounded-xl p-1.5 border border-slate-100">
            <Sparkline data={history} color={pctColor(aiRecommendation.visibilityPct)} stretch dot={false} />
          </div>
        )}
      </div>

      {/* Per-provider breakdown — only rendered once more than one AI
          provider is actually configured, so a single-provider deployment
          (today's default) looks exactly like it always has. */}
      {aiRecommendation.providerCount > 1 && aiRecommendation.providers?.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {aiRecommendation.providers.map((p) => (
            <span key={p.id} className="text-[10px] font-bold px-3 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100">
              {p.id} <span className="text-indigo-400 ml-0.5">· {p.aiVisibilityPct == null ? 'n/a' : `${p.aiVisibilityPct}%`}</span>
            </span>
          ))}
        </div>
      )}

      {/* Share of AI Voice / Competitor Citation Gap — both real, deterministic
          window metrics (server/agents/ai-recommendation.js), only shown once
          there's real window data to compute them from (null otherwise). */}
      {(aiRecommendation.shareOfAiVoicePct != null || aiRecommendation.competitorCitationGapPct != null) && (
        <div className="mt-4 pt-4 border-t border-slate-100 grid grid-cols-2 gap-3">
          {aiRecommendation.shareOfAiVoicePct != null && (
            <div className="bg-slate-50/60 border border-slate-150 rounded-xl p-3">
              <div className="text-[9px] font-black uppercase tracking-widest text-slate-400">Share of AI Voice</div>
              <div className="text-lg font-black tracking-tight text-slate-900 tabular-nums mt-0.5">{aiRecommendation.shareOfAiVoicePct}%</div>
              <div className="text-[9px] text-slate-450 font-semibold">of all tracked mentions this period</div>
            </div>
          )}
          {aiRecommendation.competitorCitationGapPct != null && (
            <div className="bg-slate-50/60 border border-slate-150 rounded-xl p-3">
              <div className="text-[9px] font-black uppercase tracking-widest text-slate-400">Competitor Citation Gap</div>
              <div className={`text-lg font-black tracking-tight tabular-nums mt-0.5 ${aiRecommendation.competitorCitationGapPct > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                {aiRecommendation.competitorCitationGapPct > 0 ? '+' : ''}{aiRecommendation.competitorCitationGapPct} pt{Math.abs(aiRecommendation.competitorCitationGapPct) === 1 ? '' : 's'}
              </div>
              <div className="text-[9px] text-slate-450 font-semibold">{aiRecommendation.competitorCitationGapPct > 0 ? 'a competitor leads' : 'you lead every tracked competitor'}</div>
            </div>
          )}
        </div>
      )}

      {/* Collapsed Competitors Section */}
      {!showPrompts && aiRecommendation.competitorsAppearingInstead?.length > 0 && (
        <div className="mt-4 pt-4 border-t border-slate-100 space-y-2.5 animate-fade-in">
          <div className="text-[9px] font-black uppercase tracking-widest text-slate-400">Competitors appearing instead</div>
          <div className="flex flex-wrap gap-1.5">
            {aiRecommendation.competitorsAppearingInstead.slice(0, 5).map((c) => (
              <span key={c.name} className="text-[10px] font-bold px-3 py-1 rounded-full bg-slate-50 text-slate-650 border border-slate-200">
                {c.name} <span className="text-slate-400 ml-0.5">· {c.count} mentions</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Expanded Grid Section (Evenly Distributed Left and Right) */}
      {promptCount > 0 && (
        <div className="mt-4 pt-4 border-t border-slate-100">
          <button 
            type="button" 
            onClick={() => setShowPrompts((s) => !s)}
            className="text-[10px] font-black uppercase tracking-wider text-[#14b8a6] hover:underline flex items-center gap-1 py-2 focus:outline-none"
          >
            {showPrompts ? 'Hide prompt scan details ↑' : `Show prompt scan details (${promptCount}) ↓`}
          </button>
          
          {showPrompts && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-4 pt-4 border-t border-slate-100/70 items-stretch animate-slide-down">
              {/* Left Column: Mentioned Prompts */}
              <div className="space-y-3 flex flex-col">
                <div className="text-[9px] font-black uppercase tracking-widest text-emerald-600 flex items-center gap-1">
                  <CheckCircle2 size={11} className="text-emerald-500" />
                  <span>Success Prompts (Mentioned)</span>
                </div>
                <div className="bg-emerald-50/15 border border-emerald-100/50 rounded-2xl p-4 flex-1 flex flex-col justify-between">
                  <ul className="space-y-2">
                    {(aiRecommendation.topPrompts || []).slice(0, 4).map((p, i) => (
                      <li key={i} className="text-[11px] font-medium text-emerald-950/80 leading-relaxed list-disc list-inside">
                        "{p.promptText}"
                      </li>
                    ))}
                    {!(aiRecommendation.topPrompts?.length) && (
                      <li className="text-[11px] text-slate-300 italic">No recommendations this period.</li>
                    )}
                  </ul>
                  <div className="text-[8px] font-bold text-emerald-600/70 border-t border-emerald-100/30 pt-2 mt-3">
                    Top listed mentions from {aiRecommendation.providerCount > 1 ? 'AI provider' : 'OpenAI'} checks
                  </div>
                </div>
              </div>

              {/* Right Column: Missed Prompts */}
              <div className="space-y-3 flex flex-col">
                <div className="text-[9px] font-black uppercase tracking-widest text-rose-600 flex items-center gap-1">
                  <AlertTriangle size={11} className="text-rose-500" />
                  <span>Missed Prompts (Competitor Shown)</span>
                </div>
                <div className="bg-rose-50/15 border border-rose-100/50 rounded-2xl p-4 flex-1 flex flex-col justify-between">
                  <ul className="space-y-2">
                    {(aiRecommendation.missedPrompts || []).slice(0, 4).map((p, i) => (
                      <li key={i} className="text-[11px] font-medium text-rose-950/85 leading-relaxed list-disc list-inside">
                        "{p.promptText}"
                      </li>
                    ))}
                    {!(aiRecommendation.missedPrompts?.length) && (
                      <li className="text-[11px] text-slate-300 italic">No missed keywords.</li>
                    )}
                  </ul>
                  <div className="text-[8px] font-bold text-rose-600/70 border-t border-rose-100/30 pt-2 mt-3">
                    Gap areas flagged for landing page insertion
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
