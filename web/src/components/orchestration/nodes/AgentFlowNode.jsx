import { useEffect, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { CATEGORY } from '../../AgentCard.jsx';
import { timeAgo } from '../../../api.js';

// Distinct per-agent icons (cosmetic only, no data claim) so the 5 SEO-
// category agents don't all render the same 🎯 category glyph — makes 10
// nodes actually scannable as 10 different things instead of 10 identical
// blobs of the same 4 category icons.
const AGENT_ICON = {
  'query-intelligence': '🔎',
  opportunity: '🎯',
  'country-intelligence': '🌍',
  'device-intelligence': '📱',
  'ai-visibility': '👁️',
  'content-gap': '📝',
  'competitor-intelligence': '⚔️',
  'technical-seo': '🛠️',
  authority: '🔗',
  'ai-recommendation': '💬',
};

// Real elapsed seconds since a run actually started, ticking every second —
// used only while isRunning is true (backed by a real in-flight fetch,
// never a decorative timer that outlives the request).
function useElapsedSeconds(startedAt, active) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active || !startedAt) { setElapsed(0); return; }
    setElapsed(Math.max(0, Math.round((Date.now() - startedAt) / 1000)));
    const id = setInterval(() => setElapsed(Math.max(0, Math.round((Date.now() - startedAt) / 1000))), 1000);
    return () => clearInterval(id);
  }, [startedAt, active]);
  return elapsed;
}

// Recency drives how "alive" a card looks — a run from 8 minutes ago should
// visually outrank one from 2 weeks ago even though both are status "ok".
// Never invents activity: an agent with no lastRunAt just renders as dim.
function recencyTier(lastRunAt) {
  if (!lastRunAt) return 'none';
  const ageMs = Date.now() - new Date(lastRunAt).getTime();
  if (ageMs < 60 * 60 * 1000) return 'fresh';
  if (ageMs < 24 * 60 * 60 * 1000) return 'recent';
  return 'stale';
}

// One node per real specialist agent (server/agents/registry.js) — status
// pill and "last run" are the agent's real latest persisted run (GET
// /agents/status), never a simulated/animated fake state. isRunning/
// runStartedAt come from the real SSE stream (GET /agents/live) via
// layout.js's buildGraph(), so several of these can be "running" at once —
// real orchestration runs agents in parallel, not one at a time.
//
// React Flow passes {id, data, selected} to a custom node component —
// `data` is exactly what buildGraph() put on this node (agent, isRunning,
// runStartedAt, onSelect).
export default function AgentFlowNode({ data }) {
  const { agent, isRunning, runStartedAt, onSelect } = data;
  const cat = CATEGORY[agent.category] || CATEGORY.seo;
  const icon = AGENT_ICON[agent.id] || cat.icon;
  const hasRun = !!agent.lastRunAt;
  const isError = hasRun && agent.lastRunStatus !== 'ok';
  const tier = isRunning ? 'running' : recencyTier(agent.lastRunAt);
  const elapsed = useElapsedSeconds(runStartedAt, isRunning);

  const glow = { running: 0.85, fresh: 0.55, recent: 0.3, stale: 0.14, none: 0 }[tier];
  const borderOpacity = { running: 'ff', fresh: 'b3', recent: '80', stale: '40', none: '26' }[tier];
  const cardOpacity = tier === 'none' ? 0.6 : 1;

  const statusText = isRunning
    ? `running… ${elapsed}s`
    : isError
      ? `${agent.lastRunStatus} · ${timeAgo(agent.lastRunAt)}`
      : hasRun
        ? `ran ${timeAgo(agent.lastRunAt)}`
        : 'idle · not yet run';
  const statusColor = isRunning ? '#a78bfa' : isError ? '#f59e0b' : hasRun ? '#34d399' : '#64748b';
  const statusDot = isRunning ? '●' : isError ? '⚠' : hasRun ? '✓' : '·';

  // Every node gets a real neutral elevation shadow regardless of tier — a
  // physically-raised card sitting on the canvas, same "real graph tool"
  // feel as n8n/Temporal. The colored glow on top of it is what modulates
  // with state (running/fresh/recent/stale); it is never the *only* shadow,
  // which is what made idle/stale cards look flat before.
  const elevation = '0 1px 2px rgba(0,0,0,0.35), 0 8px 20px -8px rgba(0,0,0,0.55)';
  const stateGlow = glow > 0 ? `, 0 0 ${8 + glow * 26}px ${isRunning ? '#a78bfa' : cat.color}${Math.round(glow * 255).toString(16).padStart(2, '0')}` : '';

  return (
    <button type="button" onClick={onSelect}
      className="group relative text-left rounded-2xl p-4 w-[220px] transition-all duration-300 hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      style={{
        background: 'linear-gradient(180deg, #2a3a63, #212f54)',
        border: `1px solid ${cat.color}${borderOpacity}`,
        outlineColor: cat.color,
        opacity: cardOpacity,
        boxShadow: elevation + stateGlow,
      }}>
      <Handle type="target" position={Position.Left} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', width: 6, height: 6 }} />
      <Handle type="source" position={Position.Right} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', width: 6, height: 6 }} />

      {isRunning && (
        <span aria-hidden className="absolute inset-0 rounded-2xl pointer-events-none"
          style={{ border: '1px solid #a78bfa', animation: 'nodePulseRing 1.6s ease-out infinite' }} />
      )}
      <div className="flex items-center gap-2.5 mb-2.5">
        <span className="w-9 h-9 rounded-xl grid place-items-center text-base shrink-0 transition-shadow group-hover:shadow-lg"
          style={{ background: `${cat.color}26`, color: cat.color, boxShadow: tier !== 'none' ? `0 0 14px ${cat.color}40` : 'none' }}>
          {icon}
        </span>
        <span className="ml-auto inline-flex items-center gap-1 text-[9.5px] font-bold uppercase tracking-wide" style={{ color: statusColor }}>
          <span className={isRunning ? 'animate-pulse' : ''}>{statusDot}</span>
        </span>
      </div>
      <p className="text-[13px] font-bold text-white leading-snug">{agent.name}</p>
      <p className="text-[10.5px] mt-1 font-mono" style={{ color: statusColor, opacity: isRunning ? 1 : 0.75 }}>
        {statusText}
      </p>
    </button>
  );
}
