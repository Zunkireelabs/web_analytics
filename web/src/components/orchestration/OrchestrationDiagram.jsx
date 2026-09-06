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

// The fit-to-container zoom floor is plain CSS (not a Tailwind class), and
// still worth easing slightly above `md` so a tablet-width container
// doesn't shrink node text further than it needs to — there's no CSS-only
// way to make a JS number responsive, so this tracks the `md` breakpoint in
// JS instead.
function useIsDesktop() {
  const query = '(min-width: 768px)';
  const [isDesktop, setIsDesktop] = useState(() => typeof window !== 'undefined' ? window.matchMedia(query).matches : true);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setIsDesktop(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return isDesktop;
}

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

// {x, y, zoom} to fit `bounds` inside a container of the given size.
function computeFit(bounds, containerWidth, containerHeight, { padding = 0.1, minZoom = 0.05, maxZoom = 1.5 } = {}) {
  const boundsWidth = Math.max(1, bounds.maxX - bounds.minX);
  const boundsHeight = Math.max(1, bounds.maxY - bounds.minY);
  const rawZoom = Math.min(
    (containerWidth * (1 - padding)) / boundsWidth,
    (containerHeight * (1 - padding)) / boundsHeight
  );
  const zoom = Math.min(maxZoom, Math.max(minZoom, rawZoom));
  return {
    zoom,
    x: containerWidth / 2 - (bounds.minX + boundsWidth / 2) * zoom,
    y: containerHeight / 2 - (bounds.minY + boundsHeight / 2) * zoom,
  };
}

// A read-only node-graph rendering of the real orchestrator (server/agents/
// orchestrator.js + runner.js) — a dotted graph-paper background, elevated
// node cards, fitted animated connectors — the same visual language as
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
  const { nodes, edges } = useMemo(
    () => buildGraph({ agents, runningAgents, onSelectAgent }),
    [agents, runningAgents, onSelectAgent]
  );
  const isDesktop = useIsDesktop();
  const [wrapperRef, size] = useElementSize();

  const bounds = useMemo(() => graphBounds(nodes), [nodes]);
  const fit = useMemo(
    () => size && computeFit(bounds, size.width, size.height, {
      padding: 0.1,
      // Desktop/tablet: floor the shrink at 0.45 so node text doesn't get
      // smaller than it needs to on a container that's already fairly wide.
      // Mobile: no meaningful floor (0.05) — always fit the entire graph in
      // the small box, whatever zoom that takes.
      minZoom: isDesktop ? 0.45 : 0.05,
      maxZoom: 1.5,
    }),
    [bounds, size, isDesktop]
  );

  return (
    <div ref={wrapperRef} className="relative w-full h-[300px] md:h-[680px] rounded-3xl overflow-hidden"
      style={{ border: '1px solid rgba(15,23,42,0.08)', background: 'rgba(255,255,255,0.35)' }}>
      <style>{`
        @keyframes orbitDash { to { stroke-dashoffset: -24; } }
        .orbit-edge { animation: orbitDash 1.4s linear infinite; }
        .orbit-edge-live { animation: orbitDash 0.6s linear infinite; }
        @keyframes nodePulseRing {
          0% { box-shadow: 0 0 0 0 rgba(124,58,237,0.45); }
          100% { box-shadow: 0 0 0 10px rgba(124,58,237,0); }
        }
        @media (prefers-reduced-motion: reduce) { .orbit-edge, .orbit-edge-live { animation: none; } }
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
              <Background variant="dots" gap={24} size={1} color="rgba(15,23,42,0.12)" />
            </ReactFlow>
          </ReactFlowProvider>
        </div>
      )}
    </div>
  );
}
