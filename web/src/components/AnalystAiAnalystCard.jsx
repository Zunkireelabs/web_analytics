import { useEffect, useState } from 'react';
import { Sparkles, CheckCircle2 } from 'lucide-react';
import { api } from '../api.js';
import { TYPE_META, evidenceBullets } from '../lib/analystFormat.js';
import AnalystConfidenceBadge from './AnalystConfidenceBadge.jsx';

// Mirrors AnalystFindingPipeline's rootCauseFallback — distinguishes "the
// nightly LLM pass hasn't run yet" from "it ran and failed," instead of one
// generic message regardless of cause.
function rootCauseFallback(insight) {
  if (insight.narration_status === 'failed') {
    return 'Root-cause tailoring failed on the last attempt — it will retry on the next nightly run.';
  }
  return 'Root-cause analysis runs nightly — check back after the next run.';
}

// The metric's most recent active (unresolved, undismissed — dashboard.py
// already filters those out) insight, narrated in real root_cause_text/
// recommendation_text from the nightly LLM pass. When nothing is active for
// this metric, that's a genuine "nothing to investigate" state, not a gap
// to paper over with invented analysis.
export default function AnalystAiAnalystCard({ clientId, metric, insight }) {
  const [confidence, setConfidence] = useState(null); // null=not fetched | {score} | {}

  useEffect(() => {
    setConfidence(null);
    if (!insight?.id) return;
    let cancelled = false;
    api.analyst.rootCause(clientId, insight.id)
      .then((r) => { if (!cancelled) setConfidence(r.status === 'ok' ? { score: r.confidence } : {}); })
      .catch(() => !cancelled && setConfidence({}));
    return () => { cancelled = true; };
  }, [clientId, insight?.id]);

  return (
    <div className="card p-6 flex flex-col">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-indigo-500" />
          <h3 className="text-xs font-black uppercase tracking-wider text-slate-600">AI Analyst</h3>
        </div>
        {insight && confidence && (
          <AnalystConfidenceBadge status={confidence.score != null ? 'ok' : 'insufficient-data'} score={confidence.score} compact />
        )}
      </div>

      {!insight ? (
        <div className="flex items-center gap-2 text-xs font-semibold text-emerald-700 bg-emerald-50/60 border border-emerald-100 rounded-2xl p-4">
          <CheckCircle2 size={14} className="text-emerald-500 shrink-0" />
          No active investigation for this metric — nothing anomalous or shifting has been flagged.
        </div>
      ) : (
        <>
          <p className="text-[9px] font-black uppercase tracking-wider mb-1.5" style={{ color: TYPE_META[insight.insight_type]?.color || '#6C63FF' }}>
            {TYPE_META[insight.insight_type]?.label || 'Finding'}
          </p>
          <p className="text-sm font-semibold text-slate-800 leading-relaxed">
            {insight.root_cause || rootCauseFallback(insight)}
          </p>
          {evidenceBullets(insight, metric).length > 0 && (
            <ul className="mt-3 space-y-1">
              {evidenceBullets(insight, metric).map((b, i) => (
                <li key={i} className="text-[10.5px] font-semibold text-slate-500 flex items-start gap-1.5">
                  <span className="w-1 h-1 rounded-full bg-slate-400 mt-1.5 shrink-0" />
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          )}
          {insight.recommendation && (
            <p className="text-[11px] font-semibold text-slate-600 mt-3 pt-3 border-t border-slate-100">
              {insight.recommendation}
            </p>
          )}
        </>
      )}
    </div>
  );
}
