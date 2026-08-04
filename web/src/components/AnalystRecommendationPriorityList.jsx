import { useEffect, useState } from 'react';
import { ListOrdered, ArrowUpRight } from 'lucide-react';
import { api } from '../api.js';
import { finding } from '../lib/analystFormat.js';
import AnalystSkeletonLoader from './AnalystSkeletonLoader.jsx';
import AnalystEmptyState from './AnalystEmptyState.jsx';

export default function AnalystRecommendationPriorityList({ clientId, insights, metricFor, onSelectRecommendation }) {
  const [state, setState] = useState(null); // null=loading | {data}

  useEffect(() => {
    setState(null);
    api.analyst.recommendationRankings(clientId)
      .then((data) => setState({ data }))
      .catch((e) => setState({ data: { rankings: [], excluded_count: 0, error: e.message || 'Failed to load priority ranking.' } }));
  }, [clientId]);

  if (state === null) {
    return (
      <div className="an-panel p-5">
        <PanelHeader />
        <div className="mt-3">
          <AnalystSkeletonLoader variant="list" rows={3} />
        </div>
      </div>
    );
  }

  const { rankings = [], excluded_count: excludedCount, error } = state.data || {};

  return (
    <div className="an-panel p-5">
      <PanelHeader count={rankings.length} />

      {error && (
        <p className="text-xs font-semibold text-rose-600 mt-2 p-2.5 rounded-xl bg-rose-50 border border-rose-500/25">
          {error}
        </p>
      )}

      {!error && rankings.length === 0 && (
        <div className="mt-3">
          <AnalystEmptyState
            icon={ListOrdered}
            title="No Prioritized Recommendations"
            description="The Recommendation Prioritizer runs nightly analysis to rank active opportunities by effort and impact score."
            compact
          />
        </div>
      )}

      {rankings.length > 0 && (
        <div className="mt-3 max-h-64 overflow-y-auto custom-scrollbar pr-1 space-y-2">
          {rankings.map((r) => {
            const insight = insights.find((i) => i.recommendation_id === r.recommendation_id);
            const metric = insight ? metricFor(insight.metric_key) : null;
            return (
              <div
                key={r.recommendation_id}
                onClick={() => onSelectRecommendation && insight && onSelectRecommendation(insight.id)}
                className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-100 p-2.5 hover:border-indigo-400 hover:bg-slate-100 transition group cursor-pointer"
              >
                <span className="w-5 h-5 rounded-lg bg-indigo-50 border border-indigo-300 text-indigo-500 grid place-items-center text-[10px] font-black shrink-0">
                  {r.rank}
                </span>

                <div className="min-w-0 flex-1">
                  <p className="text-[11.5px] font-bold text-slate-800 group-hover:text-indigo-500 transition truncate">
                    {insight ? finding(insight, metric) : `Recommendation #${r.recommendation_id}`}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5 text-[9.5px] font-semibold text-slate-500 flex-wrap">
                    <span className="text-indigo-500 font-bold bg-indigo-50 px-1.5 py-0.2 rounded">
                      Priority {r.priority_score != null ? r.priority_score.toFixed(3) : '—'}
                    </span>
                    {r.confidence != null && (
                      <span className="text-emerald-600 font-bold bg-emerald-50 px-1.5 py-0.2 rounded">
                        {Math.round(r.confidence * 100)}% Confidence
                      </span>
                    )}
                    {r.method_detail?.effort_level != null && (
                      <span>Effort {r.method_detail.effort_level}/5</span>
                    )}
                  </div>
                </div>

                <ArrowUpRight size={13} className="text-slate-500 group-hover:text-indigo-600 shrink-0 transition" />
              </div>
            );
          })}
        </div>
      )}

      {excludedCount > 0 && (
        <p className="text-[9.5px] font-medium text-slate-500 mt-2 pt-2 border-t border-slate-200">
          {excludedCount} recommendation{excludedCount === 1 ? '' : 's'} pending calculation (awaiting effort or opportunity baseline data).
        </p>
      )}
    </div>
  );
}

function PanelHeader({ count }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <div className="w-6 h-6 rounded-lg bg-indigo-50 text-indigo-500 flex items-center justify-center">
          <ListOrdered size={14} />
        </div>
        <div>
          <h3 className="text-xs font-black uppercase tracking-wider text-slate-800">Recommendation Priority</h3>
          <p className="text-[10px] font-medium text-slate-500">Ranked work queue of predicted growth actions</p>
        </div>
      </div>
      {count != null && count > 0 && (
        <span className="text-[9px] font-mono font-bold bg-slate-100 text-slate-700 px-2 py-0.5 rounded-full">
          {count} active
        </span>
      )}
    </div>
  );
}
