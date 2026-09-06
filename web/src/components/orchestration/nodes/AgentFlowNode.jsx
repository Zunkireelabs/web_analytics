import { Handle, Position } from '@xyflow/react';
import { useElapsedSeconds, getAgentStatus } from './agentVisuals.js';

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
  const elapsed = useElapsedSeconds(runStartedAt, isRunning);
  const { cat, icon, tier, glow, borderOpacity, cardOpacity, statusText, statusColor, statusDot, statusTextColor } =
    getAgentStatus(agent, { isRunning, elapsed });

  // Every node gets a real neutral elevation shadow regardless of tier — a
  // physically-raised card sitting on the canvas, same "real graph tool"
  // feel as n8n/Temporal. The colored glow on top of it is what modulates
  // with state (running/fresh/recent/stale); it is never the *only* shadow,
  // which is what made idle/stale cards look flat before.
  const elevation = '0 1px 2px rgba(15,23,42,0.08), 0 8px 20px -8px rgba(15,23,42,0.18)';
  const stateGlow = glow > 0 ? `, 0 0 ${8 + glow * 26}px ${isRunning ? '#a78bfa' : cat.color}${Math.round(glow * 255).toString(16).padStart(2, '0')}` : '';

  return (
    <button type="button" onClick={onSelect}
      className="group relative text-left rounded-2xl p-5 w-[230px] transition-all duration-300 hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      style={{
        background: 'linear-gradient(180deg, rgba(255,255,255,0.98), rgba(255,255,255,0.90))',
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
      <div className="flex items-center gap-2.5 mb-3">
        <span className="w-9 h-9 rounded-xl grid place-items-center text-base shrink-0 transition-shadow group-hover:shadow-lg"
          style={{ background: `${cat.color}26`, color: cat.color, boxShadow: tier !== 'none' ? `0 0 14px ${cat.color}40` : 'none' }}>
          {icon}
        </span>
        {agent.lastRunScore != null && (
          <span className="ml-auto text-[11px] font-black tabular-nums px-1.5 py-0.5 rounded-full" title="Real computed score"
            style={{ color: cat.color, background: `${cat.color}1f` }}>
            {agent.lastRunScore}
          </span>
        )}
        <span className={agent.lastRunScore != null ? '' : 'ml-auto'}>
          <span className="inline-flex items-center gap-1 text-[9.5px] font-bold uppercase tracking-wide" style={{ color: statusColor }}>
            <span className={isRunning ? 'animate-pulse' : ''}>{statusDot}</span>
          </span>
        </span>
      </div>
      <p className="text-[13px] font-bold text-slate-800 leading-snug">{agent.name}</p>
      <p className="text-[10.5px] mt-1 font-mono" style={{ color: statusTextColor, opacity: isRunning ? 1 : 0.9 }}>
        {statusText}
      </p>
    </button>
  );
}
