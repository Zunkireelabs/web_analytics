import { useState } from 'react';
import { useCountUp } from '../useCountUp.js';
import { timeAgo } from '../api.js';
import Sparkline from './Sparkline.jsx';

// Same three-state empty-message discipline as AuthorityScoreCard/
// CommandCenter's competitorEmptyMessage.
function emptyMessage(meta) {
  if (!meta?.openAiConfigured) return 'Not configured — needs OPENAI_API_KEY and AI_RECOMMENDATION_ENABLED=true to probe real prompts (a deliberate separate opt-in, not just the API key).';
  if (!meta?.hasRun) return 'Not analyzed yet — runs monthly.';
  if (meta.status === 'error') return 'Last run failed — check Integration Health below.';
  if (meta.status === 'insufficient-data') return `Last run (${timeAgo(meta.lastRunAt)}) had no real prompt candidates or every probe failed.`;
  return `Last run (${timeAgo(meta.lastRunAt)}) completed but returned no data.`;
}

const pctColor = (pct) => (pct >= 60 ? '#16A34A' : pct >= 25 ? '#f59e0b' : '#EF4444');

// Real, deterministically-verified AI recommendation rate — every
// "mentioned" fact is a real string/domain match against an actual raw
// OpenAI response (server/agents/ai-recommendation.js), never a fabricated
// citation. Distinct from AI Visibility (structural readiness) elsewhere in
// this dashboard — this is the real thing: does ChatGPT actually recommend
// this company for real buyer-style prompts.
export default function AiRecommendationCard({ aiRecommendation, meta, loading }) {
  const [tab, setTab] = useState('top'); // 'top' | 'missed'
  const animatedPct = useCountUp(aiRecommendation?.visibilityPct ?? 0, 900);

  if (loading) {
    return (
      <div className="card p-6 h-full flex flex-col justify-center gap-3">
        <div className="h-3 w-28 bg-slate-100 rounded animate-pulse" />
        <div className="h-11 w-20 bg-slate-200 rounded animate-pulse" />
      </div>
    );
  }

  if (!aiRecommendation) {
    return <div className="card p-8 text-center text-sm text-slate-400">{emptyMessage(meta)}</div>;
  }

  const history = (aiRecommendation.history || []).map((h) => h.pct).filter((v) => v != null);
  const list = tab === 'top' ? aiRecommendation.topPrompts : aiRecommendation.missedPrompts;

  return (
    <div className="card p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1">AI Recommendation Rate</div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-4xl font-extrabold tracking-tight text-slate-900 tabular-nums">{animatedPct}</span>
            <span className="text-sm font-semibold text-slate-400">%</span>
          </div>
          <div className="text-[11px] text-slate-400 mt-1">
            {aiRecommendation.mentionedCount} of {aiRecommendation.promptsChecked} real prompts — ChatGPT mentioned this company
          </div>
        </div>
        {history.length >= 2 && (
          <div className="w-24 h-10 shrink-0">
            <Sparkline data={history} color={pctColor(aiRecommendation.visibilityPct)} stretch dot={false} />
          </div>
        )}
      </div>

      {aiRecommendation.competitorsAppearingInstead?.length > 0 && (
        <div className="mt-4 pt-4 border-t border-slate-50">
          <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">Competitors appearing instead</div>
          <div className="flex flex-wrap gap-1.5">
            {aiRecommendation.competitorsAppearingInstead.slice(0, 6).map((c) => (
              <span key={c.name} className="text-[11px] font-medium px-2 py-1 rounded-full bg-slate-50 text-slate-600 border border-slate-100">
                {c.name} · {c.count}
              </span>
            ))}
          </div>
        </div>
      )}

      {(aiRecommendation.topPrompts?.length > 0 || aiRecommendation.missedPrompts?.length > 0) && (
        <div className="mt-3 pt-3 border-t border-slate-50">
          <div className="flex items-center gap-3 mb-2">
            <button type="button" onClick={() => setTab('top')}
              className={`text-[11px] font-semibold px-2 py-1 rounded-full transition-colors ${tab === 'top' ? 'bg-emerald-50 text-emerald-700' : 'text-slate-400 hover:text-slate-600'}`}>
              Mentioned ({aiRecommendation.topPrompts?.length || 0})
            </button>
            <button type="button" onClick={() => setTab('missed')}
              className={`text-[11px] font-semibold px-2 py-1 rounded-full transition-colors ${tab === 'missed' ? 'bg-rose-50 text-rose-600' : 'text-slate-400 hover:text-slate-600'}`}>
              Missed ({aiRecommendation.missedPrompts?.length || 0})
            </button>
          </div>
          <ul className="space-y-1.5 fade-up">
            {(list || []).slice(0, 6).map((p, i) => (
              <li key={i} className="text-[11px] text-slate-600 leading-relaxed">"{p.promptText}"</li>
            ))}
            {!list?.length && <li className="text-[11px] text-slate-300">None this run.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
