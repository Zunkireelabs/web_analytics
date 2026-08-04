import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Cell, Tooltip } from 'recharts';
import { BarChart2 } from 'lucide-react';
import { api } from '../api.js';
import AnalystConfidenceBadge from './AnalystConfidenceBadge.jsx';

const BAR_COLORS = ['#6C63FF', '#8b5cf6', '#0ea5e9', '#10b981', '#f59e0b', '#e11d48'];

// Real permutation importance (app/ml/feature_importance.py) — a
// GradientBoostingRegressor's own measured performance drop per feature,
// never a heuristic ranking. Nightly-only: shows an honest "not yet
// computed" state for a metric with no run yet rather than fabricating bars.
export default function AnalystFeatureImportanceChart({ clientId, targetMetricKey }) {
  const [state, setState] = useState(null); // null=loading | {data}

  useEffect(() => {
    setState(null);
    api.analyst.featureImportance(clientId, targetMetricKey)
      .then((data) => setState({ data }))
      .catch((e) => setState({ data: { status: 'error', error: e.message } }));
  }, [clientId, targetMetricKey]);

  const data = state?.data;
  const rows = data?.status === 'ok' ? data.features.slice(0, 6) : [];

  return (
    <div className="card p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <BarChart2 size={14} className="text-indigo-500" />
          <h3 className="text-xs font-black uppercase tracking-wider text-slate-600">Feature Importance</h3>
        </div>
        {data?.status === 'ok' && (
          <AnalystConfidenceBadge status="ok" score={data.confidence} sampleSize={data.n_observations} modelVersion={data.model_type} compact />
        )}
      </div>

      {state === null && <p className="text-xs text-slate-400 font-medium animate-pulse">Loading model output…</p>}
      {data?.status === 'not-yet-computed' && (
        <p className="text-xs text-slate-400 font-medium">Feature importance runs nightly — check back after the next run.</p>
      )}
      {(data?.status === 'insufficient-data' || data?.status === 'error') && (
        <p className="text-xs text-slate-400 font-medium">{data.error || 'Not enough overlapping history to fit a model for this metric.'}</p>
      )}
      {data?.status === 'ok' && rows.length > 0 && (
        <ResponsiveContainer width="100%" height={40 * rows.length + 20}>
          <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 24, left: 0, bottom: 0 }}>
            <XAxis type="number" domain={[0, 'dataMax']} hide />
            <YAxis type="category" dataKey="feature_metric_key" width={140}
              tick={{ fontSize: 10, fill: '#475569', fontWeight: 700 }} axisLine={false} tickLine={false} />
            <Tooltip formatter={(v) => `${Math.round(v * 10) / 10}%`} cursor={{ fill: '#f8fafc' }} />
            <Bar dataKey="importance_pct" radius={[0, 8, 8, 0]} barSize={16} label={{ position: 'right', fontSize: 10, fontWeight: 700, formatter: (v) => `${Math.round(v)}%` }}>
              {rows.map((_, i) => <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
