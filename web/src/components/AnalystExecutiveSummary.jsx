import { useEffect, useState } from 'react';
import { Sparkles, RefreshCw, TrendingUp, Search, DollarSign, ArrowRight, CheckCircle2 } from 'lucide-react';
import { api } from '../api.js';
import AnalystSkeletonLoader from './AnalystSkeletonLoader.jsx';
import AnalystEmptyState from './AnalystEmptyState.jsx';

const FIELD_META = [
  { key: 'forecast_summary', label: 'Forecast', icon: TrendingUp },
  { key: 'root_cause_summary', label: 'Root Cause', icon: Search },
  { key: 'recommended_action', label: 'Recommended Action', icon: ArrowRight },
  { key: 'business_impact_summary', label: 'Expected Business Impact', icon: DollarSign },
  { key: 'biggest_issue', label: 'Biggest Issue', icon: Sparkles },
];

export default function AnalystExecutiveSummary({ clientId }) {
  const [state, setState] = useState(null); // null=loading | {error} | {data}

  const load = () => {
    setState(null);
    api.analyst.executiveSummary(clientId)
      .then((data) => setState({ data }))
      .catch((e) => setState({ error: e.message || 'Failed to generate executive summary' }));
  };

  useEffect(load, [clientId]);

  if (state === null) {
    return <AnalystSkeletonLoader variant="hero" />;
  }

  return (
    <div
      className="rounded-3xl p-7 text-slate-900 relative overflow-hidden shadow-2xl border border-indigo-500/20"
      style={{ background: 'linear-gradient(135deg,#ffffff 0%,#ffffff 45%,#4338ca 100%)' }}
    >
      <div className="absolute -top-20 -right-20 w-80 h-80 rounded-full opacity-20 blur-3xl pointer-events-none" style={{ background: '#8b5cf6' }} />
      
      <div className="relative flex items-center justify-between gap-4 mb-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-slate-100 border border-white/15 flex items-center justify-center shadow-xs">
            <Sparkles size={18} className="text-indigo-500 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-black uppercase tracking-widest text-indigo-500">AI Executive Summary</h2>
              <span className="text-[9px] font-mono font-bold bg-indigo-100 border border-violet-400/30 text-indigo-500 px-2 py-0.5 rounded-md">
                LLM Synthesized
              </span>
            </div>
            {state?.data?.metric && (
              <p className="text-[11px] font-semibold text-slate-900/60 mt-0.5">
                Highest-priority finding · <span className="text-indigo-500 font-bold">{state.data.metric}</span> · <span className="capitalize text-amber-600">{state.data.severity}</span> severity
              </p>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={load}
          disabled={state === null}
          className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 border border-white/10 text-slate-900/70 hover:text-slate-900 transition disabled:opacity-30 cursor-pointer"
          title="Regenerate Executive Summary"
        >
          <RefreshCw size={14} className={state === null ? 'animate-spin' : ''} />
        </button>
      </div>

      {state?.error && (
        <div className="p-4 rounded-2xl bg-rose-950/60 border border-rose-800/80 text-rose-600 text-xs font-semibold">
          {state.error}
        </div>
      )}

      {state?.data?.status === 'no-active-insights' && (
        <div className="my-2">
          <AnalystEmptyState
            icon={CheckCircle2}
            title="All Clear — No Active Insights"
            description="The AI Analyst agent found no active anomalies or risks requiring immediate executive triage."
          />
        </div>
      )}

      {state?.data?.status === 'ok' && (
        <div className="relative space-y-5">
          {state.data.overall_status && (
            <div className="inline-flex items-center gap-2.5 px-4 py-2 rounded-2xl bg-slate-100 border border-white/15 backdrop-blur-md text-lg font-black tracking-tight text-slate-900 shadow-xs">
              <span>{state.data.overall_status}</span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {FIELD_META.map(({ key, label, icon: Icon }) => {
              const val = state.data[key];
              if (!val) return null;
              return (
                <div key={key} className="rounded-2xl bg-slate-50 border border-white/10 p-4 hover:bg-slate-100 transition">
                  <div className="flex items-center gap-2 mb-2 text-indigo-500">
                    <Icon size={13} />
                    <span className="text-[10px] font-black uppercase tracking-wider">{label}</span>
                  </div>
                  <p className="text-xs font-medium text-slate-900/90 leading-relaxed">{val}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
