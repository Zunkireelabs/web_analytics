import { useEffect, useState } from 'react';
import { CheckCircle2, Circle, Loader2, Ban } from 'lucide-react';
import { api } from '../api.js';

// Every stage here is a real, derivable state — never a fabricated
// "progress" animation. For any insight ineligible for the SEO draft->PR
// pipeline (every GA4 metric, every non-page GSC insight — see
// isSeoDraftEligible), the 7th stage renders as a dead-end note rather than
// pretending progress is still coming.
const STAGE_DEFS = [
  { key: 'detected', label: 'Detected' },
  { key: 'validated', label: 'Validated' },
  { key: 'simulation', label: 'Simulation Complete' },
  { key: 'impact', label: 'Projected Impact' },
  { key: 'draft', label: 'Draft Generated' },
  { key: 'approval', label: 'Waiting Human Approval' },
  { key: 'deploy', label: 'Ready to Deploy' },
];

export default function AnalystActionPipeline({ clientId, insight, seoEligible, impactResult, draftStatus }) {
  const [rootCauseOk, setRootCauseOk] = useState(null); // null=loading, true/false

  useEffect(() => {
    if (!insight?.id) { setRootCauseOk(false); return; }
    setRootCauseOk(null);
    api.analyst.rootCause(clientId, insight.id)
      .then((r) => setRootCauseOk(r.status === 'ok'))
      .catch(() => setRootCauseOk(false));
  }, [clientId, insight?.id]);

  const hasRecommendation = Boolean(insight.recommendation_id);
  const resolved = false; // this component only renders for active findings
  const simulationOk = impactResult?.status === 'ok';

  const statusFor = (key) => {
    switch (key) {
      case 'detected': return 'done';
      case 'validated': return rootCauseOk === null ? 'pending' : rootCauseOk ? 'done' : 'skipped';
      case 'simulation': return simulationOk ? 'done' : impactResult ? 'skipped' : 'pending';
      case 'impact': return simulationOk ? 'done' : 'pending';
      case 'draft': return hasRecommendation ? 'done' : 'pending';
      case 'approval': return hasRecommendation && !resolved ? 'active' : hasRecommendation ? 'done' : 'pending';
      case 'deploy':
        if (!seoEligible) return 'dead-end';
        if (draftStatus === 'approved' || draftStatus === 'submitted_for_approval' || draftStatus === 'implemented') return 'done';
        return 'pending';
      default: return 'pending';
    }
  };

  return (
    <div className="flex flex-col gap-0">
      {STAGE_DEFS.map((stage, idx) => {
        const status = statusFor(stage.key);
        const isLast = idx === STAGE_DEFS.length - 1;
        return (
          <div key={stage.key} className="flex gap-3">
            <div className="flex flex-col items-center">
              <StageIcon status={status} />
              {!isLast && <div className={`w-px flex-1 min-h-[18px] ${status === 'done' ? 'bg-emerald-400/60' : 'bg-slate-700/60'}`} />}
            </div>
            <div className="pb-4">
              <div className={`text-[10px] font-black uppercase tracking-wider ${
                status === 'dead-end' ? 'text-slate-800' : status === 'skipped' ? 'text-slate-400' : status === 'pending' ? 'text-slate-500' : 'text-slate-800'
              }`}>
                {stage.label}
              </div>
              {stage.key === 'impact' && simulationOk && (
                <div className="text-[11px] font-bold text-slate-800 mt-0.5">
                  {impactResult.currency} {Math.round(impactResult.projected_dollar_delta).toLocaleString()}
                </div>
              )}
              {stage.key === 'deploy' && status === 'dead-end' && (
                <div className="text-[9px] font-semibold text-slate-400 mt-0.5">No deploy path for this finding type</div>
              )}
              {stage.key === 'validated' && status === 'skipped' && (
                <div className="text-[9px] font-semibold text-slate-400 mt-0.5">Root cause not yet computed</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StageIcon({ status }) {
  if (status === 'done') return <CheckCircle2 size={16} className="text-emerald-600 shrink-0" />;
  if (status === 'active') return <Loader2 size={16} className="text-indigo-600 animate-spin shrink-0" />;
  if (status === 'dead-end') return <Ban size={16} className="text-slate-700 shrink-0" />;
  if (status === 'skipped') return <Circle size={16} className="text-slate-400 shrink-0" />;
  return <Circle size={16} className="text-slate-500 shrink-0" />;
}
