import { useEffect, useState } from 'react';
import { api, daysAgo, timeAgo } from '../../api.js';
import { ORCH_CATEGORY as CATEGORY } from './palette.js';

const DEFAULT_START = daysAgo(7);
const DEFAULT_END = daysAgo(0);

// Slide-over triggered by clicking a node in the orchestration diagram —
// the same real "run this agent for the last 7 days" capability the old
// flat grid (AgentCard.jsx) had, just reached by clicking the node instead
// of a permanently-visible button, so the diagram stays the primary view.
export default function AgentDetailPanel({ agent, onClose }) {
  const [state, setState] = useState('idle'); // idle | running | done | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [showFacts, setShowFacts] = useState(false);

  useEffect(() => {
    setState('idle'); setResult(null); setError(null); setShowFacts(false);
  }, [agent?.id]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!agent) return null;
  const cat = CATEGORY[agent.category] || CATEGORY.seo;
  const missing = (agent.dataSources || []).filter((d) => d.status !== 'connected');

  // Just kicks off the real run — the orchestration diagram's live pulse
  // comes from the SSE stream (GET /agents/live, off runner.js), not from
  // this promise resolving, so it animates identically whether started here
  // or by the diagram's own "Run all agents" button.
  const run = async () => {
    setState('running'); setError(null);
    try {
      const out = await api.runAgent(agent.id, DEFAULT_START, DEFAULT_END);
      setResult(out); setState('done');
    } catch (e) {
      setError(e.message || 'Run failed'); setState('error');
    }
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-40 fade-up" style={{ animationDuration: '0.15s' }} onClick={onClose} />
      <div className="fixed top-0 right-0 bottom-0 w-full max-w-md bg-white z-50 shadow-2xl overflow-y-auto">
        <div className="p-5 border-b border-slate-100 flex items-start justify-between gap-3 sticky top-0 bg-white">
          <div className="min-w-0">
            <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full"
              style={{ color: cat.color, background: `${cat.color}1a` }}>{cat.label}</span>
            <h2 className="text-lg font-bold text-slate-900 mt-2 leading-snug">{agent.name}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
            className="w-10 h-10 grid place-items-center rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-100 text-2xl leading-none shrink-0 -mt-1 -mr-1.5 transition-colors">×</button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-sm text-slate-600 leading-relaxed">{agent.description}</p>

          <div className="text-xs text-slate-400">
            {agent.lastRunAt
              ? <>Last run {timeAgo(agent.lastRunAt)} — <span className={agent.lastRunStatus === 'ok' ? 'text-emerald-600 font-semibold' : 'text-amber-600 font-semibold'}>{agent.lastRunStatus}</span>{agent.lastRunFindings != null && `, ${agent.lastRunFindings} findings`}</>
              : 'Not yet run for this site.'}
          </div>

          {agent.requires?.length > 0 && (
            <div className="text-xs text-slate-400">Synthesizes {agent.requires.length} other agents' findings into one narrative.</div>
          )}

          {missing.length > 0 && (
            <div className="pt-1">
              <div className="text-[10px] font-semibold text-amber-600 uppercase tracking-wide mb-1.5 flex items-center gap-1">
                <span>⏳</span> Needs data source
              </div>
              <div className="flex flex-wrap gap-1.5">
                {missing.map((ds) => (
                  <span key={ds.id} title={ds.description}
                    className="text-[10px] font-medium px-2 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-100">
                    {ds.id}
                  </span>
                ))}
              </div>
            </div>
          )}

          <button type="button" onClick={run} disabled={state === 'running'}
            className="w-full text-xs font-semibold py-2.5 rounded-lg text-white transition disabled:opacity-60"
            style={{ background: '#6C63FF' }}>
            {state === 'running' ? 'Running… (~10-30s)' : 'Run analysis (last 7 days)'}
          </button>

          {state === 'error' && <p className="text-[11px] text-rose-600">{error}</p>}

          {state === 'done' && result && (
            <div className="pt-3 border-t border-slate-100 space-y-2.5">
              {result.status !== 'ok' ? (
                <p className="text-xs text-slate-500">{result.message || `Status: ${result.status}`}</p>
              ) : (
                <>
                  {result.narrative && <p className="text-xs text-slate-600 leading-relaxed">{result.narrative}</p>}
                  <button type="button" onClick={() => setShowFacts((s) => !s)}
                    className="text-[10px] font-semibold text-slate-400 hover:text-slate-600">
                    {showFacts ? 'Hide raw data ↑' : 'View raw data →'}
                  </button>
                  {showFacts && (
                    <pre className="text-[10px] bg-slate-50 rounded-lg p-2.5 overflow-x-auto max-h-64 overflow-y-auto text-slate-600">
                      {JSON.stringify(result.facts, null, 2)}
                    </pre>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
