import { BaseEdge, getBezierPath } from '@xyflow/react';
import { CHART } from '../../../lib/palette.js';

// One edge component for every connection in the graph — centralizes the
// same color/width/opacity/animation semantics the old hand-rolled SVG
// overlay used, now driven by React Flow's real fitted anchor points
// instead of manually measured getBoundingClientRect() centers.
//
// `data.live` (set by layout.js's buildGraph() from the real SSE-driven
// runningAgents Map): the agent feeding this edge is actually running right
// now — brighter, faster, thicker. `data.loopBack`: the dashed pink
// Executive Report → Command Center synthesis edge. Everything else is a
// plain idle grey connector (static; only live edges animate, in the accent).
export default function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const isLive = !!data?.live;
  const isLoopBack = !!data?.loopBack;

  // data.color is no longer used: idle edges are neutral grey.
  const stroke = isLive ? CHART.highlight : '#d4d4d4';
  const strokeWidth = isLive ? 2 : 1.25;
  const strokeDasharray = isLive ? '5 7' : isLoopBack ? '3 5' : undefined;
  const className = isLive ? 'orbit-edge-live' : 'orbit-edge';

  return (
    <BaseEdge id={id} path={path} markerEnd={markerEnd}
      style={{ stroke, strokeWidth, opacity: 1, strokeDasharray, strokeLinecap: 'round' }}
      className={className} />
  );
}
