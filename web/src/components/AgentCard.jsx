import { useState } from 'react';
import { api, daysAgo } from '../api.js';

const CATEGORY = {
  seo:     { label: 'SEO',       icon: '🎯', color: '#6C63FF' },
  geo:     { label: 'Geo',       icon: '🌐', color: '#0ea5e9' },
  content: { label: 'Content',   icon: '📝', color: '#14b8a6' },
  meta:    { label: 'Executive', icon: '🧠', color: '#ec4899' },
};

// Default analysis window when a card's "Run analysis" button is used
// directly (no date range picker on this page) — last 7 full days.
const DEFAULT_START = daysAgo(7);
const DEFAULT_END = daysAgo(0);

// One registered AI Agent — runs for real via POST /api/agents/:id/run and
// shows its real narrative + a status pill, instead of the old static
// "Coming soon" placeholder.
export default function AgentCard({ agent }) {
  const cat = CATEGORY[agent.category] || CATEGORY.seo;
  const missing = (agent.dataSources || []).filter((d) => d.status !== 'connected');

  const [state, setState] = useState('idle'); // idle | running | done | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [showFacts, setShowFacts] = useState(false);

  const run = async () => {
    setState('running');
    setError(null);
    try {
      const out = await api.runAgent(agent.id, DEFAULT_START, DEFAULT_END);
      setResult(out);
      setState('done');
    } catch (e) {
      setError(e.message || 'Run failed');
      setState('error');
    }
  };

  return (
    <div className="card card-hover p-5 fade-up flex flex-col">
      <div className="flex items-start justify-between gap-2">
        <span className="w-10 h-10 rounded-xl grid place-items-center text-lg shrink-0"
          style={{ background: `${cat.color}1a`, color: cat.color }}>{cat.icon}</span>
        <StatusPill state={state} runStatus={result?.status} />
      </div>

      <h3 className="text-[15px] font-bold text-slate-900 mt-3">{agent.name}</h3>
      <p className="text-xs text-slate-500 mt-1.5 leading-relaxed line-clamp-3">{agent.description}</p>

      <div className="mt-auto pt-4 flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded-full"
          style={{ background: `${cat.color}1a`, color: cat.color }}>{cat.label}</span>
        {agent.requires?.length > 0 && (
          <span className="text-[10px] text-slate-400">Combines {agent.requires.length} agents</span>
        )}
      </div>

      {missing.length > 0 && (
        <div className="mt-3 pt-3 border-t border-slate-50">
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

      <button
        type="button"
        onClick={run}
        disabled={state === 'running'}
        className="mt-3 w-full text-xs font-semibold py-2 rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed"
        style={{ background: `${cat.color}1a`, color: cat.color }}
      >
        {state === 'running' ? 'Running…' : state === 'done' ? 'Run again' : 'Run analysis'}
      </button>

      {state === 'error' && (
        <p className="mt-2 text-[11px] text-rose-600">{error}</p>
      )}

      {state === 'done' && result && (
        <div className="mt-3 pt-3 border-t border-slate-100 space-y-2">
          {result.status !== 'ok' ? (
            <p className="text-xs text-slate-500">{result.message || `Status: ${result.status}`}</p>
          ) : (
            <>
              {result.narrative && (
                <p className="text-xs text-slate-600 leading-relaxed">{result.narrative}</p>
              )}
              <button
                type="button"
                onClick={() => setShowFacts((s) => !s)}
                className="text-[10px] font-semibold text-slate-400 hover:text-slate-600"
              >
                {showFacts ? 'Hide raw data ↑' : 'View raw data →'}
              </button>
              {showFacts && (
                <pre className="text-[10px] bg-slate-50 rounded-lg p-2.5 overflow-x-auto max-h-52 overflow-y-auto text-slate-600">
                  {JSON.stringify(result.facts, null, 2)}
                </pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function StatusPill({ state, runStatus }) {
  if (state === 'running') {
    return <span className="text-[10px] font-semibold text-slate-400 bg-slate-50 rounded-full px-2 py-1 shrink-0 animate-pulse">Running…</span>;
  }
  if (state === 'error') {
    return <span className="text-[10px] font-semibold text-rose-600 bg-rose-50 rounded-full px-2 py-1 shrink-0">Error</span>;
  }
  if (state === 'done') {
    if (runStatus === 'ok') return <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-50 rounded-full px-2 py-1 shrink-0">Analyzed</span>;
    return <span className="text-[10px] font-semibold text-amber-600 bg-amber-50 rounded-full px-2 py-1 shrink-0">Insufficient data</span>;
  }
  return <span className="text-[10px] font-semibold text-slate-400 bg-slate-50 rounded-full px-2 py-1 shrink-0">Not yet run</span>;
}
