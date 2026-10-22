import { Handle, Position } from '@xyflow/react';
import { useElapsedSeconds, getAgentStatus } from './agentVisuals.js';

// One node per real specialist agent (server/agents/registry.js) — status
// text and "last run" are the agent's real latest persisted run (GET
// /agents/status), never a simulated/animated fake state. isRunning/
// runStartedAt come from the real SSE stream (GET /agents/live) via
// layout.js's buildGraph(), so several of these can be "running" at once —
// real orchestration runs agents in parallel, not one at a time.
//
// React Flow passes {id, data, selected} to a custom node component —
// `data` is exactly what buildGraph() put on this node (agent, isRunning,
// runStartedAt, onSelect).
const RING = '0 0 0 1px var(--border-canvas)';

export default function AgentFlowNode({ data }) {
  const { agent, isRunning, runStartedAt, onSelect } = data;
  const elapsed = useElapsedSeconds(runStartedAt, isRunning);
  const { cat, cardOpacity, statusText, statusColor, statusTextColor } =
    getAgentStatus(agent, { isRunning, elapsed });

  return (
    <button type="button" onClick={onSelect}
      className="relative text-left bg-white rounded-control p-3.5 w-[230px] min-h-[88px] flex flex-col justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      style={{ opacity: cardOpacity, boxShadow: isRunning ? '0 0 0 1.5px var(--primary)' : RING, outlineColor: 'var(--primary)' }}
      onMouseEnter={(e) => { if (!isRunning) e.currentTarget.style.boxShadow = '0 0 0 1px #d6d3cf'; }}
      onMouseLeave={(e) => { e.currentTarget.style.boxShadow = isRunning ? '0 0 0 1.5px var(--primary)' : RING; }}>
      <Handle type="target" position={Position.Left} style={{ background: 'transparent', border: 'none', width: 6, height: 6 }} />
      <Handle type="source" position={Position.Right} style={{ background: 'transparent', border: 'none', width: 6, height: 6 }} />

      {isRunning && (
        <span aria-hidden className="absolute inset-0 rounded-control pointer-events-none"
          style={{ animation: 'nodePulseRing 1.6s ease-out infinite' }} />
      )}
      <div className="flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: cat.color }} />
        <p className="text-[13px] font-medium text-fg leading-snug min-w-0 flex-1">{agent.name}</p>
        {agent.lastRunScore != null && (
          <span className="text-xs tnum text-text shrink-0" title="Real computed score">{agent.lastRunScore}</span>
        )}
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: statusColor }} />
      </div>
      <p className="text-[11px] mt-1.5 font-mono" style={{ color: statusTextColor }}>
        {statusText}
      </p>
    </button>
  );
}
