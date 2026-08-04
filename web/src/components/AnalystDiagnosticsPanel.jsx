import { useEffect, useState } from 'react';
import { Activity, Gauge } from 'lucide-react';
import { api } from '../api.js';

// "Diagnostics from an ML system" — every value here is a real computation
// (app/stats/diagnostics.py) with its own honest insufficient-data state,
// never a placeholder number. Model Used/Training Window/Forecast Horizon
// come straight off the forecast run itself (already fetched by the trend
// card) rather than a separate engine.
export default function AnalystDiagnosticsPanel({ clientId, metricKey }) {
  const [diag, setDiag] = useState(null); // null=loading
  const [series, setSeries] = useState(null); // for forecast metadata (model/horizon/training window)

  useEffect(() => {
    setDiag(null);
    setSeries(null);
    api.analyst.diagnostics(clientId, metricKey).then(setDiag).catch(() => setDiag({}));
    api.analyst.series(clientId, metricKey).then(setSeries).catch(() => setSeries({}));
  }, [clientId, metricKey]);

  const forecast = series?.forecast;
  const trainingWindow = series?.series?.length ? `${series.series.length} days` : '—';

  const stats = [
    { key: 'volatility', label: 'Volatility', fmt: (v) => v.toFixed(2) },
    { key: 'trend_strength', label: 'Trend Strength', fmt: (v) => `${Math.round(v * 100)}%` },
    { key: 'seasonality_strength', label: 'Seasonality', fmt: (v) => `${Math.round(v * 100)}%` },
    { key: 'prediction_error', label: 'Prediction Error (MAPE)', fmt: (v) => `${Math.round(v * 100)}%` },
    { key: 'r_squared', label: 'Forecast R²', fmt: (v) => v.toFixed(2) },
  ];

  return (
    <div className="an-panel p-6">
      <div className="flex items-center gap-2 mb-4">
        <Activity size={14} className="text-sky-600" />
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-400">Statistical Analysis</h3>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {stats.map(({ key, label, fmt }) => {
          const r = diag?.[key];
          const ok = r?.status === 'ok' && r.value != null;
          return (
            <div key={key} className="rounded-xl border border-slate-200 bg-slate-100/70 p-3">
              <div className="text-[8px] font-black uppercase tracking-wider text-slate-500">{label}</div>
              <div className="text-sm font-extrabold text-slate-800 mt-1">
                {diag === null ? '…' : ok ? fmt(r.value) : '—'}
              </div>
              {!ok && diag !== null && (
                <div className="text-[8px] font-semibold text-slate-500 mt-0.5">{r?.detail?.reason || 'insufficient data'}</div>
              )}
            </div>
          );
        })}

        <StaticStat label="Model Used" value={forecast?.status === 'ok' ? forecast.model : '—'} />
        <StaticStat label="Training Window" value={trainingWindow} />
        <StaticStat label="Forecast Horizon" value={forecast?.horizon_periods ? `${forecast.horizon_periods} periods` : '—'} />
        <StaticStat label="Forecast Confidence" value={forecast?.confidence != null ? `${Math.round(forecast.confidence * 100)}%` : '—'} />
        <StaticStat label="Data Completeness" value={diag?.volatility?.detail?.n_observations ? `${diag.volatility.detail.n_observations}/${diag.volatility.detail.window_days || 28} days` : '—'} />
      </div>
      <p className="text-[9px] font-semibold text-slate-500 mt-4 flex items-center gap-1">
        <Gauge size={10} /> Statistics computed live from this client's own observed history — never an industry benchmark.
      </p>
    </div>
  );
}

function StaticStat({ label, value }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-100/70 p-3">
      <div className="text-[8px] font-black uppercase tracking-wider text-slate-500">{label}</div>
      <div className="text-sm font-extrabold text-slate-800 mt-1">{value}</div>
    </div>
  );
}
