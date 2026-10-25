import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, ReactFlowProvider, Background } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import AgentFlowNode from './nodes/AgentFlowNode.jsx';
import HubFlowNode from './nodes/HubFlowNode.jsx';
import FlowEdge from './edges/FlowEdge.jsx';
import { buildGraph } from './layout.js';

// Stable references — React Flow requires nodeTypes/edgeTypes to not be
// recreated every render (a documented perf footgun: a new object identity
// each render forces React Flow to re-mount every node/edge).
const NODE_TYPES = { agent: AgentFlowNode, hub: HubFlowNode };
const EDGE_TYPES = { flow: FlowEdge };

// Measures a DOM element's rendered size, synchronously via
// getBoundingClientRect() in a layout effect (fast path — correct as soon as
// CSS has applied, which it has by the time layout effects run) and kept
// current afterward via a dedicated ResizeObserver for real resizes
// (window resize, orientation change, breakpoint crossing).
function useElementSize() {
  const ref = useRef(null);
  const [size, setSize] = useState(null); // null until first real measurement
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) setSize({ width: rect.width, height: rect.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

// Bounding box directly from each node's known position + explicit
// width/height (both plain data already set by buildGraph/layout.js — no
// DOM measurement needed).
function graphBounds(nodes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const w = n.width || 0;
    const h = n.height || 0;
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + w);
    maxY = Math.max(maxY, n.position.y + h);
  }
  return { minX, minY, maxX, maxY };
}

// A read-only node-graph rendering of the real orchestrator (server/agents/
// orchestrator.js + runner.js) — a dotted graph-paper background, quiet white
// node cards, grey static connectors (orange and animated only while live) — the same visual language as
// n8n/LangGraph Studio/Temporal's workflow UIs, built on React Flow.
//
// Fully static (no pan/zoom/drag, at every breakpoint): React Flow's own
// viewport machinery — fitView(), setViewport(), and the declarative
// defaultViewport prop — all turned out to be unreliable in this app (see
// below), and its interactive pan/zoom shares that same internal viewport
// state. Rather than ship a canvas where dragging might silently do nothing
// (worse than not offering it), this always renders the whole graph
// pre-fitted to its container and leaves interaction out entirely; tap a
// node for full detail in AgentDetailPanel instead of panning to it.
//
// The fit itself is plain CSS: a `transform` on the wrapper below, computed
// from the nodes' own known positions/sizes. That's deliberately NOT
// fitView()/setViewport()/defaultViewport — all three were tried and none
// actually applied here. fitView()/useNodesInitialized() never resolved,
// even in a production build: node.measured stayed undefined, and its
// internal per-node ResizeObserver's .observe() was confirmed called but
// its callback never fired (a plain, hand-rolled ResizeObserver on a single
// element fired normally in the same environment — this is specific to
// React Flow's internal one). A manual setViewport() call resolved `true`
// while the store's transform silently stayed at its {0,0,1} default, and
// passing defaultViewport — including a deliberately absurd test value —
// had no visible effect either. Scaling/positioning the wrapper with CSS
// instead cannot silently no-op the way those three did.
export default function OrchestrationDiagram({ agents, onSelectAgent, runningAgents }) {
  const { nodes, edges } = useMemo(() => {
    const g = buildGraph({ agents, runningAgents, onSelectAgent });
    // layout.js centres the columns on a fixed Y, so a tall graph has nodes at
    // negative coordinates — outside React Flow's own box, which clips them.
    // Shift everything so the graph's top-left is (0, 0).
    const b = graphBounds(g.nodes);
    return {
      edges: g.edges,
      nodes: g.nodes.map((n) => ({ ...n, position: { x: n.position.x - b.minX, y: n.position.y - b.minY } })),
    };
  }, [agents, runningAgents, onSelectAgent]);
  const [wrapperRef, size] = useElementSize();

  const bounds = useMemo(() => graphBounds(nodes), [nodes]);
  // Fit by WIDTH, then size the canvas height from the graph's own aspect
  // ratio. The real graph is far taller than wide (35 agents in two sub-
  // columns), so fitting it into a fixed-height box shrank the node text to
  // ~6px and, once the zoom hit its floor, clipped both side columns. Deriving
  // the height keeps the whole graph inside the box with an even margin at the
  // largest legible zoom, at every container width (ResizeObserver re-measures
  // on resize / tab switch).
  const PAD = 0.06;
  const layoutFit = useMemo(() => {
    if (!size) return null;
    const bw = Math.max(1, bounds.maxX - bounds.minX);
    const bh = Math.max(1, bounds.maxY - bounds.minY);
    const zoom = Math.min(1.5, Math.max(0.2, (size.width * (1 - PAD)) / bw));
    const margin = size.width * (PAD / 2);
    return {
      zoom,
      height: Math.max(300, Math.ceil(bh * zoom + margin * 2)),
      x: (size.width - bw * zoom) / 2 - bounds.minX * zoom,
      y: margin - bounds.minY * zoom,
    };
  }, [bounds, size]);
  const fit = layoutFit;

  return (
    <div ref={wrapperRef} className="relative w-full overflow-hidden"
      style={{ background: '#fcfcfb', height: fit ? fit.height : 680 }}>
      <style>{`
        @keyframes orbitDash { to { stroke-dashoffset: -24; } }
        .orbit-edge-live { animation: orbitDash 0.6s linear infinite; }
        @keyframes nodePulseRing {
          0% { box-shadow: 0 0 0 0 rgba(213,78,0,0.35); }
          100% { box-shadow: 0 0 0 10px rgba(213,78,0,0); }
        }
        @media (prefers-reduced-motion: reduce) { .orbit-edge-live { animation: none; } }
        .orchestration-flow .react-flow__attribution { display: none; }
      `}</style>

      {size && fit && (
        <div
          className="absolute top-0 left-0"
          style={{
            width: bounds.maxX,
            height: bounds.maxY,
            transform: `translate(${fit.x}px, ${fit.y}px) scale(${fit.zoom})`,
            transformOrigin: '0 0',
          }}
        >
          <ReactFlowProvider>
            <ReactFlow className="orchestration-flow" nodes={nodes} edges={edges}
              nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}
              style={{ width: bounds.maxX, height: bounds.maxY, background: 'transparent' }}
              minZoom={1} maxZoom={1}
              nodesDraggable={false} nodesConnectable={false} elementsSelectable={false}
              panOnDrag={false} zoomOnPinch={false}
              panOnScroll={false} zoomOnScroll={false} zoomOnDoubleClick={false}
              proOptions={{ hideAttribution: true }}>
              <Background variant="dots" gap={16} size={1} color="#e9e7e4" />
            </ReactFlow>
          </ReactFlowProvider>
        </div>
      )}
    </div>
  );
}
