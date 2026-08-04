// Renders data-analyst-agent/app/scoring/impact_projection.py's dual-mode
// ROI Estimation output (Phase 2 plan Stage 5) — mode='currency' when the
// client has business values configured, mode='metric_unit' otherwise (a
// real sessions-equivalent delta, never a fabricated dollar figure
// standing in for one this client can't support yet).
export default function AnalystRoiEstimate({ result, error }) {
  if (error) return <p className="text-[10px] font-semibold text-rose-600">{error}</p>;
  if (!result) return null;

  if (result.status === 'ok' && result.mode === 'currency') {
    return (
      <p className="text-[10px] font-bold text-slate-800">
        {result.currency} {Math.round(result.projected_dollar_delta).toLocaleString()}
        {result.confidence != null && (
          <span className="text-slate-500 font-semibold"> · {Math.round(result.confidence * 100)}% confidence</span>
        )}
      </p>
    );
  }

  if (result.status === 'ok' && result.mode === 'metric_unit') {
    return (
      <div>
        <p className="text-[10px] font-bold text-slate-800">
          {result.projected_metric_unit_delta > 0 ? '+' : ''}
          {Math.round(result.projected_metric_unit_delta).toLocaleString()} {result.metric_unit}
          {result.confidence != null && (
            <span className="text-slate-500 font-semibold"> · {Math.round(result.confidence * 100)}% confidence</span>
          )}
        </p>
        <p className="text-[9px] font-semibold text-slate-500 mt-1">
          No dollar figure yet — configure business values for this client to see a currency estimate.
        </p>
      </div>
    );
  }

  return <p className="text-[10px] font-semibold text-slate-500">Not computable for this finding.</p>;
}
