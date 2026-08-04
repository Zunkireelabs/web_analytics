import { useEffect, useState } from 'react';
import { Brain, ArrowDown } from 'lucide-react';
import { api } from '../api.js';
import { formatByUnit } from '../lib/analystFormat.js';
import AnalystConfidenceBadge from './AnalystConfidenceBadge.jsx';

// Visualizes the REAL root-cause tree (root_cause_analysis_runs/nodes) as a
// causal chain — never a synthetic narrative like "Traffic Down -> Mobile ->
// Position Drop -> Core Update"; every step here is a real dimension mover
// this client's own data produced. Root Cause Analysis is nightly-only, so
// this shows an honest "not yet computed" state rather than inventing one.
export default function AnalystReasoningPanel({ clientId, insight, metric }) {
  const [state, setState] = useState(null); // null=loading | {data}

  useEffect(() => {
    if (!insight?.id) { setState({ data: { status: 'unavailable' } }); return; }
    setState(null);
    api.analyst.rootCause(clientId, insight.id)
      .then((data) => setState({ data }))
      .catch((e) => setState({ data: { status: 'error', error: e.message } }));
  }, [clientId, insight?.id]);

  if (!insight) {
    return (
      <div className="an-panel p-6">
        <PanelHeader />
        <p className="text-xs text-slate-500 font-medium mt-3">Select a finding to see how the AI traced its cause.</p>
      </div>
    );
  }

  const data = state?.data;
  return (
    <div className="an-panel p-6">
      <PanelHeader />
      {state === null && <p className="text-xs text-slate-500 font-medium animate-pulse mt-3">Loading root cause…</p>}
      {data?.status === 'unavailable' && <p className="text-xs text-slate-500 font-medium mt-3">This finding has no id to look up.</p>}
      {data?.status === 'not-yet-computed' && (
        <p className="text-xs text-slate-500 font-medium mt-3">Root cause analysis runs nightly — check back after the next run.</p>
      )}
      {(data?.status === 'insufficient-data' || data?.status === 'error') && (
        <p className="text-xs text-slate-500 font-medium mt-3">{data.error || 'Not enough data to attribute a root cause for this finding.'}</p>
      )}
      {data?.status === 'ok' && (
        <div className="mt-4 flex flex-col items-start gap-1">
          <ChainNode label="Root Metric Change" node={data.root} unit={metric?.unit} highlight />
          <ArrowDown size={14} className="text-slate-600 ml-4" />
          <div className="flex flex-wrap gap-3 w-full">
            {data.children.map((n, idx) => (
              <ChainNode key={idx} label={`${n.dimension_type} · ${n.dimension_value}`} node={n} unit={metric?.unit} />
            ))}
          </div>
          <div className="mt-3 w-full">
            <AnalystConfidenceBadge status="ok" score={data.confidence} modelVersion={data.method} />
          </div>
        </div>
      )}
    </div>
  );
}

function PanelHeader() {
  return (
    <div className="flex items-center gap-2">
      <Brain size={14} className="text-indigo-600" />
      <h3 className="text-xs font-black uppercase tracking-wider text-slate-400">AI Reasoning Panel</h3>
    </div>
  );
}

function ChainNode({ label, node, unit, highlight }) {
  if (!node) return null;
  const positive = (node.pct_change ?? 0) >= 0;
  return (
    <div className={`rounded-2xl border p-3 min-w-[160px] ${highlight ? 'border-indigo-300 bg-indigo-50' : 'border-slate-200 bg-slate-100/70'}`}>
      <div className="text-[9px] font-black uppercase tracking-wider text-slate-500 truncate" title={label}>{label}</div>
      <div className={`text-sm font-extrabold mt-1 ${positive ? 'text-emerald-600' : 'text-rose-600'}`}>
        {node.pct_change != null ? `${positive ? '+' : ''}${Math.round(node.pct_change * 10) / 10}%` : '—'}
      </div>
      <div className="text-[9px] font-semibold text-slate-500 mt-0.5">
        {formatByUnit(node.prior_value, unit)} → {formatByUnit(node.current_value, unit)}
      </div>
      {node.share_of_baseline_change_pct != null && (
        <div className="text-[9px] font-bold text-slate-400 mt-1">{Math.round(node.share_of_baseline_change_pct)}% of baseline change</div>
      )}
    </div>
  );
}
