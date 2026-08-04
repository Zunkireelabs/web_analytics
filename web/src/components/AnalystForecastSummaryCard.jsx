import { useEffect, useState } from 'react';
import { Target } from 'lucide-react';
import { api } from '../api.js';
import { formatByUnit, pct } from '../lib/analystFormat.js';

const R = 30;
const CIRCUMFERENCE = 2 * Math.PI * R;

function reliabilityFor(confidence) {
  if (confidence == null) return { label: 'Not yet scored', color: '#94a3b8' };
  const p = Math.round(confidence * 100);
  if (p >= 70) return { label: 'Reliable', color: '#059669' };
  if (p >= 40) return { label: 'Moderate', color: '#d97706' };
  return { label: 'Low confidence', color: '#e11d48' };
}

// Companion to the forecast chart — same forecast object AnalystTrendCard
// already renders, summarized as one number + one gauge instead of a line.
// Training window is the only field here that isn't already on the metric
// card, so this fetches the same series call AnalystDiagnosticsPanel does
// (cheap, cached by the browser) rather than skip the field.
export default function AnalystForecastSummaryCard({ clientId, metric }) {
  const [trainingDays, setTrainingDays] = useState(null);

  useEffect(() => {
    setTrainingDays(null);
    api.analyst.series(clientId, metric.metric_key)
      .then((d) => setTrainingDays(d.series?.length ?? null))
      .catch(() => setTrainingDays(null));
  }, [clientId, metric.metric_key]);

  const forecast = metric.forecast;
  const lastPoint = forecast?.status === 'ok' && forecast.points?.length ? forecast.points[forecast.points.length - 1] : null;
  const horizonPctChange = lastPoint && metric.latest_value
    ? ((lastPoint.point_estimate - metric.latest_value) / Math.abs(metric.latest_value)) * 100
    : null;
  const confidence = forecast?.status === 'ok' ? forecast.confidence : null;
  const reliability = reliabilityFor(confidence);
  const dashOffset = confidence != null ? CIRCUMFERENCE * (1 - confidence) : CIRCUMFERENCE;

  return (
    <div className="card p-6 flex flex-col">
      <div className="flex items-center gap-2 mb-4">
        <Target size={14} className="text-violet-500" />
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-600">Forecast Summary</h3>
      </div>

      {forecast?.status !== 'ok' ? (
        <p className="text-xs font-medium text-slate-400">No forecast available for this metric yet.</p>
      ) : (
        <>
          <div className="text-[28px] leading-none font-extrabold text-slate-900 tracking-tight">
            {lastPoint ? formatByUnit(lastPoint.point_estimate, metric.unit) : '—'}
          </div>
          <div className="text-[11px] font-bold text-slate-400 mt-1.5">
            {lastPoint ? `by ${lastPoint.target_date}` : ''}{forecast.horizon_periods ? ` · ${forecast.horizon_periods}-period horizon` : ''}
          </div>

          <div className="flex items-center gap-4 mt-5">
            <svg width="66" height="66" viewBox="0 0 72 72">
              <circle cx="36" cy="36" r={R} fill="none" stroke="#eef1f6" strokeWidth="7" />
              <circle
                cx="36" cy="36" r={R} fill="none" stroke={reliability.color} strokeWidth="7" strokeLinecap="round"
                strokeDasharray={CIRCUMFERENCE} strokeDashoffset={dashOffset} transform="rotate(-90 36 36)"
              />
              <text x="36" y="40" textAnchor="middle" fontSize="14" fontWeight="800" fill="#0f172a">
                {confidence != null ? `${Math.round(confidence * 100)}%` : '—'}
              </text>
            </svg>
            <div>
              <div className="text-base font-extrabold" style={{ color: reliability.color }}>{reliability.label}</div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Forecast reliability</div>
            </div>
          </div>

          <div className="mt-4 divide-y divide-slate-100 border-t border-slate-100">
            <Row k="Expected change" v={horizonPctChange != null ? pct(horizonPctChange) : '—'} tone={horizonPctChange > 0 ? 'pos' : horizonPctChange < 0 ? 'neg' : null} />
            <Row k="Model used" v={forecast.model || '—'} />
            <Row k="Prediction horizon" v={forecast.horizon_periods ? `${forecast.horizon_periods} periods` : '—'} />
            <Row k="Training window" v={trainingDays != null ? `${trainingDays} days` : '…'} />
          </div>
        </>
      )}
    </div>
  );
}

function Row({ k, v, tone }) {
  return (
    <div className="flex items-center justify-between py-2 text-[11.5px]">
      <span className="text-slate-400 font-bold">{k}</span>
      <span className={`font-extrabold ${tone === 'pos' ? 'text-emerald-600' : tone === 'neg' ? 'text-rose-600' : 'text-slate-800'}`}>{v}</span>
    </div>
  );
}
