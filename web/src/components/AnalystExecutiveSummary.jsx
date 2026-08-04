import { useEffect, useState } from 'react';
import { Sparkles, RefreshCw, TrendingUp, Search, DollarSign, ArrowRight, CheckCircle2 } from 'lucide-react';
import { api } from '../api.js';

// Ordered to lead with forward-looking/prescriptive fields (Forecast, Root
// Cause, Recommended Action) — Biggest Issue is still shown, but as framing
// for the rest rather than the headline; see the Analyst page redesign
// plan (predict/diagnose/fix, not "what happened" reporting).
const FIELD_META = [
  { key: 'forecast_summary', label: 'Forecast', icon: TrendingUp },
  { key: 'root_cause_summary', label: 'Root Cause', icon: Search },
  { key: 'recommended_action', label: 'Recommended Action', icon: ArrowRight },
  { key: 'business_impact_summary', label: 'Expected Business Impact', icon: DollarSign },
  { key: 'biggest_issue', label: 'Biggest Issue', icon: Sparkles },
];

// The page's visual focal point — a single LLM-synthesized narrative
// grounded entirely in real fetched fields (see generate_dashboard_
// executive_summary on the backend). On-demand only: this calls an LLM, so
// it fires once per client mount, not on every render, with an explicit
// refresh button rather than polling.
export default function AnalystExecutiveSummary({ clientId }) {
  const [state, setState] = useState(null); // null=loading | {error} | {data}

  const load = () => {
    setState(null);
    api.analyst.executiveSummary(clientId)
      .then((data) => setState({ data }))
      .catch((e) => setState({ error: e.message || 'Failed to generate executive summary' }));
  };

  useEffect(load, [clientId]);

  return (
    <div
      className="rounded-3xl p-7 text-white relative overflow-hidden"
      style={{ background: 'linear-gradient(135deg,#1e1b4b,#312e81 45%,#4c1d95)' }}
    >
      <div className="absolute -top-16 -right-16 w-64 h-64 rounded-full opacity-20 blur-3xl" style={{ background: '#8b5cf6' }} />
      <div className="relative flex items-start justify-between gap-4 mb-5">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-white/10 flex items-center justify-center">
            <Sparkles size={16} className="text-violet-300" />
          </div>
          <div>
            <h2 className="text-sm font-black uppercase tracking-widest text-violet-300">AI Executive Summary</h2>
            {state?.data?.metric && (
              <p className="text-[11px] font-semibold text-white/50">
                Highest-priority finding · {state.data.metric} · {state.data.severity} severity
              </p>
            )}
          </div>
        </div>
        <button
          type="button" onClick={load} disabled={state === null}
          className="text-white/50 hover:text-white transition disabled:opacity-30 cursor-pointer"
          title="Regenerate"
        >
          <RefreshCw size={15} className={state === null ? 'animate-spin' : ''} />
        </button>
      </div>

      {state === null && (
        <p className="text-sm text-white/60 font-medium animate-pulse">Synthesizing the current state of this account…</p>
      )}

      {state?.error && (
        <p className="text-sm text-rose-300 font-semibold">{state.error}</p>
      )}

      {state?.data?.status === 'no-active-insights' && (
        <div className="flex items-center gap-2 text-emerald-300 font-bold text-lg">
          <CheckCircle2 size={20} /> All clear — no active findings for this client.
        </div>
      )}

      {state?.data?.status === 'ok' && (
        <div className="relative">
          <div className="inline-flex items-center gap-2 text-2xl font-black tracking-tight mb-5">
            {state.data.overall_status}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {FIELD_META.map(({ key, label, icon: Icon }) => (
              <div key={key} className="rounded-2xl bg-white/5 border border-white/10 p-4">
                <div className="flex items-center gap-1.5 mb-1.5 text-violet-300">
                  <Icon size={12} />
                  <span className="text-[9px] font-black uppercase tracking-wider">{label}</span>
                </div>
                <p className="text-[13px] font-medium text-white/90 leading-relaxed">{state.data[key]}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
