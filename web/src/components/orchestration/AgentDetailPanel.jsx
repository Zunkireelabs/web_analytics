import { useEffect, useState } from 'react';
import { Bot } from 'lucide-react';
import { api, daysAgo, timeAgo } from '../../api.js';
import Drawer from '../Drawer.jsx';
import Button from '../Button.jsx';
import Badge from '../Badge.jsx';
import { STATUS } from '../../lib/palette.js';
import { ORCH_CATEGORY as CATEGORY } from './palette.js';
import { getAgentStatus } from './nodes/agentVisuals.js';

const DEFAULT_START = daysAgo(7);
const DEFAULT_END = daysAgo(0);

// Slide-over triggered by clicking a node in the orchestration diagram —
// the same real "run this agent for the last 7 days" capability the old
// flat grid (AgentCard.jsx) had, just reached by clicking the node instead
// of a permanently-visible button, so the diagram stays the primary view.
// The shell (overlay, Escape, close button) is the shared Drawer.
export default function AgentDetailPanel({ agent, onClose }) {
  const [state, setState] = useState('idle'); // idle | running | done | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [showFacts, setShowFacts] = useState(false);

  useEffect(() => {
    setState('idle'); setResult(null); setError(null); setShowFacts(false);
  }, [agent?.id]);

  const cat = CATEGORY[agent?.category] || CATEGORY.seo;
  const missing = (agent?.dataSources || []).filter((d) => d.status !== 'connected');
  const subtitle = agent ? `${cat.label} · ${getAgentStatus(agent).statusText}` : undefined;

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
    <Drawer isOpen={!!agent} onClose={onClose} title={agent?.name} subtitle={subtitle} icon={Bot}>
      {agent && (
        <div className="space-y-4">
          <p className="text-sm text-text">{agent.description}</p>

          {agent.lastRunScore != null && (
            <div className="flex items-baseline gap-2">
              <span className="text-[22px] font-medium tracking-[-0.02em] text-fg tnum">{agent.lastRunScore}</span>
              <span className="text-sm text-faint">/ 100 real computed score</span>
            </div>
          )}

          <div className="text-[13px] text-faint">
            {agent.lastRunAt
              ? <>Last run {timeAgo(agent.lastRunAt)} — <span className="font-medium"
                  style={{ color: agent.lastRunStatus === 'ok' ? STATUS.good.text : STATUS.warning.text }}>{agent.lastRunStatus}</span>{agent.lastRunFindings != null && `, ${agent.lastRunFindings} findings`}</>
              : 'Not yet run for this site.'}
          </div>

          {agent.requires?.length > 0 && (
            <div className="text-[13px] text-faint">Synthesizes {agent.requires.length} other agents' findings into one narrative.</div>
          )}

          {missing.length > 0 && (
            <div>
              <div className="text-xs text-faint mb-1.5">Needs data source</div>
              <div className="flex flex-wrap gap-1.5">
                {missing.map((ds) => (
                  <span key={ds.id} title={ds.description}><Badge tone="amber">{ds.id}</Badge></span>
                ))}
              </div>
            </div>
          )}

          <Button variant="primary" className="w-full" onClick={run} disabled={state === 'running'}>
            {state === 'running' ? 'Running… (~10-30s)' : 'Run analysis (last 7 days)'}
          </Button>

          {state === 'error' && <p className="text-[13px]" style={{ color: STATUS.critical.text }}>{error}</p>}

          {state === 'done' && result && (
            <div className="pt-3 border-t border-border space-y-2.5">
              {result.status !== 'ok' ? (
                <p className="text-[13px] text-text">{result.message || `Status: ${result.status}`}</p>
              ) : (
                <>
                  {result.narrative && <p className="text-[13px] text-text">{result.narrative}</p>}
                  <Button variant="ghost" size="sm" className="-ml-2.5" onClick={() => setShowFacts((s) => !s)} aria-expanded={showFacts}>
                    {showFacts ? 'Hide raw data' : 'View raw data'}
                  </Button>
                  {showFacts && (
                    <pre className="text-xs font-mono bg-muted rounded-control p-3 overflow-x-auto max-h-64 overflow-y-auto text-text">
                      {JSON.stringify(result.facts, null, 2)}
                    </pre>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
