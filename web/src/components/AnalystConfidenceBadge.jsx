import { ShieldCheck, ShieldQuestion } from 'lucide-react';

// One reusable "how trustworthy is this" badge, shared across every panel
// that has a ConfidenceResult-shaped object from the backend (forecast
// confidence, root cause, feature importance, impact projection) — never a
// per-panel reimplementation, and never a fabricated score when the
// backend itself reported 'insufficient-data'.
export default function AnalystConfidenceBadge({
  status, score, sampleSize, lastAnalysis, modelVersion, compact = false,
}) {
  const insufficient = status !== 'ok' || score == null;
  const pct = insufficient ? null : Math.round(score * 100);
  const color = insufficient ? '#94a3b8' : pct >= 70 ? '#10b981' : pct >= 40 ? '#f59e0b' : '#e11d48';
  const Icon = insufficient ? ShieldQuestion : ShieldCheck;

  if (compact) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider px-2 py-1 rounded-lg w-fit"
        style={{ color, backgroundColor: `${color}0f` }}
        title={insufficient ? 'Not enough data yet for a confidence score' : `${pct}% confidence`}
      >
        <Icon size={10} />
        {insufficient ? 'No confidence yet' : `${pct}% confidence`}
      </span>
    );
  }

  return (
    <div className="rounded-xl border border-slate-150 bg-slate-50/60 p-2.5 flex flex-col gap-1">
      <div className="flex items-center gap-1.5" style={{ color }}>
        <Icon size={12} />
        <span className="text-[9px] font-black uppercase tracking-wider">
          {insufficient ? 'Insufficient data' : `${pct}% confidence`}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] font-semibold text-slate-400">
        {sampleSize != null && <span>Sample: {sampleSize.toLocaleString()}</span>}
        {modelVersion && <span>Model: {modelVersion}</span>}
        {lastAnalysis && <span>Updated {new Date(lastAnalysis).toLocaleDateString()}</span>}
      </div>
    </div>
  );
}
