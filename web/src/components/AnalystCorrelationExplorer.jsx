import { Fragment, useEffect, useState } from 'react';
import { Network } from 'lucide-react';
import { api } from '../api.js';

function colorForR(r) {
  if (r == null) return '#f1f5f9';
  const intensity = Math.min(Math.abs(r), 1);
  return r >= 0 ? `rgba(16,185,129,${0.12 + intensity * 0.6})` : `rgba(225,29,72,${0.12 + intensity * 0.6})`;
}

// A real Pearson correlation matrix (app/ml/correlation.py) — distinct from
// the anomaly co-occurrence heuristic elsewhere in this app, which is
// explicitly not a coefficient. Cells with too few overlapping days render
// as empty rather than a fabricated r.
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
    <div className="card p-6">
      <div className="flex items-center gap-2 mb-4">
        <Network size={14} className="text-emerald-500" />
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-600">Correlation Explorer</h3>
      </div>

      {state === null && <p className="text-xs text-slate-400 font-medium animate-pulse">Computing correlations…</p>}
      {(data?.status === 'insufficient-data' || data?.status === 'error') && (
        <p className="text-xs text-slate-400 font-medium">{data.detail?.reason || data.error || 'Not enough overlapping data to compute correlations yet.'}</p>
      )}

      {data?.status === 'ok' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div>
            <div className="text-[9px] font-black uppercase tracking-wider text-slate-400 mb-2">Strongest relationships</div>
            <div className="space-y-2">
              {data.top_pairs.slice(0, 8).map((p, idx) => (
                <div key={idx} className="flex items-center justify-between gap-2 text-[11px] font-bold text-slate-700 rounded-xl border border-slate-150 bg-slate-50/60 px-3 py-2">
                  <span className="truncate">{p.metric_a} <span className="text-slate-300">↔</span> {p.metric_b}</span>
                  <span className={p.r >= 0 ? 'text-emerald-600' : 'text-rose-600'}>{p.r.toFixed(2)}</span>
                </div>
              ))}
              {data.top_pairs.length === 0 && <p className="text-xs text-slate-400 font-medium">No pairs met the minimum overlap threshold.</p>}
            </div>
          </div>

          <div className="overflow-x-auto">
            <div className="text-[9px] font-black uppercase tracking-wider text-slate-400 mb-2">Full matrix</div>
            <div className="inline-grid" style={{ gridTemplateColumns: `120px repeat(${data.metric_keys.length}, 22px)` }}>
              <div />
              {data.metric_keys.map((k) => (
                <div key={k} className="text-[7px] font-bold text-slate-400 [writing-mode:vertical-rl] rotate-180 h-[70px] flex items-end justify-center pb-1" title={k}>
                  {k}
                </div>
              ))}
              {data.metric_keys.map((rowKey) => (
                <Fragment key={rowKey}>
                  <div className="text-[8px] font-bold text-slate-500 truncate pr-1 flex items-center" title={rowKey}>{rowKey}</div>
                  {data.metric_keys.map((colKey) => {
                    const r = data.matrix[rowKey]?.[colKey];
                    return (
                      <div key={`${rowKey}-${colKey}`} className="w-[22px] h-[22px]" style={{ backgroundColor: colorForR(r) }} title={r != null ? `${rowKey} ↔ ${colKey}: ${r.toFixed(2)}` : 'insufficient overlap'} />
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
