import { useEffect, useState } from 'react';
import { Target, ChevronDown, ChevronUp } from 'lucide-react';
import { api } from '../api.js';

// Human labels for data-analyst-agent/app/intelligence/opportunity_scoring.py's
// 8 named factors — search_volume and probability_of_success are ALWAYS
// excluded server-side (no honest signal for either yet, see that engine's
// own docstring), rendered here exactly like any other excluded factor,
// never hidden.
const FACTOR_LABELS = {
  impact: 'Impact', statistical_confidence: 'Statistical Confidence', affected_page_count: 'Affected Pages',
  search_volume: 'Search Volume', trend_direction: 'Trend Direction', existing_performance: 'Existing Performance',
  difficulty: 'Difficulty', probability_of_success: 'Probability of Success',
};

// Nightly-cached (Phase 2 plan Stage 6) — auto-fetches on mount rather than
// a manual trigger button, same convention as AnalystReasoningPanel's root
// cause fetch. Renders nothing (not even a loading state) when there's no
// recommendation yet to score.
export default function AnalystOpportunityBadge({ clientId, recommendationId }) {
  const [state, setState] = useState(null); // null=loading | {data}
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!recommendationId) return;
    setState(null);
    api.analyst.opportunityScore(clientId, recommendationId)
      .then((data) => setState({ data }))
      .catch((e) => setState({ data: { status: 'error', error: e.message } }));
  }, [clientId, recommendationId]);

  if (!recommendationId) return <p className="text-[10px] font-semibold text-slate-400">No recommendation to score yet.</p>;
  if (state === null) return <p className="text-[10px] font-semibold text-slate-400 animate-pulse">Scoring opportunity…</p>;

  const data = state.data;
  if (data.status === 'not-yet-computed') {
    return <p className="text-[10px] font-semibold text-slate-400">Opportunity scoring runs nightly — check back after the next run.</p>;
  }
  if (data.status === 'insufficient-data' || data.status === 'error') {
    return <p className="text-[10px] font-semibold text-slate-400">{data.error || 'Not enough data to score this opportunity yet.'}</p>;
  }

  const score = data.opportunity_score;
  const color = score >= 66 ? '#10b981' : score >= 33 ? '#f59e0b' : '#e11d48';
  const factors = Object.entries(data.factors || {});
  const includedCount = factors.filter(([, f]) => f.included).length;

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="inline-flex items-center gap-1.5 text-[9px] font-black uppercase tracking-wider px-2.5 py-1.5 rounded-lg cursor-pointer focus:outline-none"
        style={{ color, backgroundColor: `${color}0f` }}
      >
        <Target size={11} />
        {Math.round(score)}/100 opportunity
        <span className="text-slate-400 font-semibold normal-case">({includedCount}/{factors.length} factors)</span>
        {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
      </button>
      {expanded && (
        <ul className="mt-1.5 space-y-1">
          {factors.map(([name, f]) => (
            <li key={name} className="text-[9px] font-semibold flex items-start gap-1.5">
              <span className={`w-1 h-1 rounded-full mt-1.5 shrink-0 ${f.included ? 'bg-emerald-400' : 'bg-slate-600'}`} />
              <span className={f.included ? 'text-slate-300' : 'text-slate-500'}>
                {FACTOR_LABELS[name] || name}
                {f.included ? `: ${Math.round(f.value * 100)}%` : ` — excluded (${f.reason})`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
