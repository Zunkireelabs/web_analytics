import { Fragment, useEffect, useState } from 'react';
import { Network, Sparkles, Layers } from 'lucide-react';
import { api } from '../api.js';
import AnalystEmptyState from './AnalystEmptyState.jsx';

function colorForR(r) {
  if (r == null) return 'rgba(241,245,249,0.5)';
  const intensity = Math.min(Math.abs(r), 1);
  return r >= 0 ? `rgba(16,185,129,${0.15 + intensity * 0.7})` : `rgba(225,29,72,${0.15 + intensity * 0.7})`;
}

export default function AnalystCorrelationExplorer({ clientId }) {
  const [state, setState] = useState(null); // null=loading | {data}

  useEffect(() => {
    setState(null);
    api.analyst.correlations(clientId)
      .then((data) => setState({ data }))
      .catch((e) => setState({ data: { status: 'error', error: e.message } }));
  }, [clientId]);

  const data = state?.data;

  return (
    <div className="an-panel p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center">
            <Network size={14} />
          </div>
          <div>
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Correlation & Driver Explorer</h3>
            <p className="text-[10px] font-medium text-slate-500">Pearson correlation matrix across ingested metric time-series</p>
          </div>
        </div>
      </div>

      {state === null && (
        <p className="text-xs text-slate-500 font-medium animate-pulse py-4">Computing mathematical correlations…</p>
      )}

      {(data?.status === 'insufficient-data' || data?.status === 'error') && (
        <AnalystEmptyState
          icon={Layers}
          title="Insufficient Overlap Data"
          description={data?.detail?.reason || data?.error || 'Awaiting additional daily time-series data to calculate Pearson correlation coefficients.'}
          compact
        />
      )}

      {data?.status === 'ok' && (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-6 items-start">
          {/* Top Correlated Pairs */}
          <div className="space-y-2">
            <div className="text-[9.5px] font-black uppercase tracking-wider text-slate-500 mb-1.5">Strongest Metric Relationships</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {data.top_pairs.slice(0, 6).map((p, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between gap-2 text-[11px] font-bold text-slate-800 rounded-xl border border-slate-200 bg-slate-100/70 p-2.5 hover:bg-slate-100 hover:border-indigo-300 transition"
                >
                  <span className="truncate flex items-center gap-1.5">
                    <span className="font-mono text-[10px] text-slate-700">{p.metric_a}</span>
                    <span className="text-slate-600 font-normal">↔</span>
                    <span className="font-mono text-[10px] text-slate-700">{p.metric_b}</span>
                  </span>
                  <span className={`font-mono font-black text-xs ${p.r >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {p.r.toFixed(2)}
                  </span>
                </div>
              ))}
              {data.top_pairs.length === 0 && (
                <p className="text-xs text-slate-500 font-medium col-span-2">No pairs met the minimum overlap threshold.</p>
              )}
            </div>
          </div>

          {/* Compact Heatmap Matrix */}
          <div className="overflow-x-auto p-3 rounded-2xl bg-slate-100/70 border border-slate-200">
            <div className="text-[9.5px] font-black uppercase tracking-wider text-slate-500 mb-2">Correlation Matrix</div>
            <div className="inline-grid gap-1" style={{ gridTemplateColumns: `80px repeat(${Math.min(data.metric_keys.length, 8)}, 18px)` }}>
              <div />
              {data.metric_keys.slice(0, 8).map((k) => (
                <div key={k} className="text-[7px] font-mono text-slate-500 truncate text-center" title={k}>
                  {k.substring(0, 3)}
                </div>
              ))}
              {data.metric_keys.slice(0, 8).map((rowKey) => (
                <Fragment key={rowKey}>
                  <div className="text-[8px] font-mono text-slate-400 truncate pr-1 flex items-center" title={rowKey}>
                    {rowKey.substring(0, 10)}
                  </div>
                  {data.metric_keys.slice(0, 8).map((colKey) => {
                    const r = data.matrix[rowKey]?.[colKey];
                    return (
                      <div
                        key={`${rowKey}-${colKey}`}
                        className="w-[18px] h-[18px] rounded-xs transition hover:scale-125 hover:z-10 cursor-pointer"
                        style={{ backgroundColor: colorForR(r) }}
                        title={r != null ? `${rowKey} ↔ ${colKey}: ${r.toFixed(2)}` : 'insufficient data'}
                      />
                    );
                  })}
                </Fragment>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
