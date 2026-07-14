import { BaseEdge, getBezierPath } from '@xyflow/react';

// One edge component for every connection in the graph — centralizes the
// same color/width/opacity/animation semantics the old hand-rolled SVG
// overlay used, now driven by React Flow's real fitted anchor points
// instead of manually measured getBoundingClientRect() centers.
//
// `data.live` (set by layout.js's buildGraph() from the real SSE-driven
// runningAgents Map): the agent feeding this edge is actually running right
// now — brighter, faster, thicker. `data.loopBack`: the dashed pink
// Executive Report → Command Center synthesis edge. Everything else is a
// plain idle brand-purple connector.
export default function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const isLive = !!data?.live;
  const isLoopBack = !!data?.loopBack;

  const stroke = isLive ? '#a78bfa' : data?.color || '#6C63FF';
  const strokeWidth = isLive ? 2.5 : isLoopBack ? 1.5 : 1.75;
  const opacity = isLive ? 0.9 : isLoopBack ? 0.45 : 0.35;
  const strokeDasharray = isLoopBack ? '3 5' : '5 7';
  const className = isLive ? 'orbit-edge-live' : 'orbit-edge';

  return (
    <BaseEdge id={id} path={path} markerEnd={markerEnd}
      style={{ stroke, strokeWidth, opacity, strokeDasharray, strokeLinecap: 'round' }}
      className={className} />
  );
}
