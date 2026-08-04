import { useEffect, useState } from 'react';
import { ListOrdered } from 'lucide-react';
import { api } from '../api.js';
import { finding } from '../lib/analystFormat.js';

// Client-wide ranked work queue from data-analyst-agent/app/intelligence/
// prioritizer.py (Phase 2 plan Stage 7) — priority_score = (opportunity_
// score/100) x confidence / effort_level; see that engine's own docstring
// for why this departs from the plan's literal 4-term formula. The backend
// already excludes resolved/dismissed recommendations and anything missing
// an upstream Opportunity Score/Effort Estimation row (excluded_count) —
// this component surfaces that count rather than silently showing a
// shorter list with no explanation.
export default function AnalystRecommendationPriorityList({ clientId, insights, metricFor }) {
  const [state, setState] = useState(null); // null=loading | {data}

  useEffect(() => {
    setState(null);
    api.analyst.recommendationRankings(clientId)
      .then((data) => setState({ data }))
      .catch((e) => setState({ data: { rankings: [], excluded_count: 0, error: e.message || 'Failed to load priority ranking.' } }));
  }, [clientId]);

  if (state === null) {
    return (
      <div className="card p-6">
        <PanelHeader />
        <p className="text-xs text-slate-400 font-medium animate-pulse mt-3">Loading priority ranking…</p>
      </div>
    );
  }

  const { rankings, excluded_count: excludedCount, error } = state.data;

  return (
    <div className="card p-6">
      <PanelHeader count={rankings.length} />
      {error && <p className="text-xs font-semibold text-rose-500 mt-3">{error}</p>}
      {!error && rankings.length === 0 && (
        <p className="text-xs text-slate-400 font-medium mt-3">No ranked recommendations yet — the Recommendation Prioritizer runs nightly.</p>
      )}
      {rankings.length > 0 && (
        <ol className="mt-3 space-y-1.5">
          {rankings.map((r) => {
            const insight = insights.find((i) => i.recommendation_id === r.recommendation_id);
            const metric = insight ? metricFor(insight.metric_key) : null;
            return (
              <li key={r.recommendation_id} className="flex items-center gap-2.5 rounded-xl border border-slate-150 bg-slate-50/60 p-2.5">
                <span className="w-5 h-5 rounded-lg bg-white border border-slate-200 grid place-items-center text-[9px] font-black text-slate-500 shrink-0">
                  {r.rank}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-bold text-slate-700 truncate">
                    {insight ? finding(insight, metric) : `Recommendation #${r.recommendation_id}`}
                  </p>
                  <p className="text-[9px] font-semibold text-slate-400">
                    Priority {r.priority_score.toFixed(3)}
                    {r.confidence != null && ` · ${Math.round(r.confidence * 100)}% confidence`}
                    {r.method_detail?.effort_level != null && ` · Effort ${r.method_detail.effort_level}/5`}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {excludedCount > 0 && (
        <p className="text-[9px] font-semibold text-slate-400 mt-2">
          {excludedCount} recommendation{excludedCount === 1 ? '' : 's'} excluded — missing effort or opportunity data.
        </p>
      )}
    </div>
  );
}

function PanelHeader({ count }) {
  return (
    <div className="flex items-center gap-2">
      <ListOrdered size={14} className="text-indigo-500" />
      <h3 className="text-xs font-black uppercase tracking-wider text-slate-600">Recommendation Priority</h3>
      {count != null && count > 0 && <span className="text-[10px] font-bold text-slate-400">({count})</span>}
    </div>
  );
}
