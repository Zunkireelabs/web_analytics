import { useEffect, useMemo, useRef } from 'react';
import { ReactFlow, ReactFlowProvider, Background, Controls, useReactFlow } from '@xyflow/react';
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

// The declarative `fitView` prop can run before custom nodes have actually
// been measured by React Flow's ResizeObserver (a documented timing race —
// see @xyflow/react's fitView docs), which is exactly what clipped the
// consumer column off-canvas before. Calling fitView() imperatively one
// frame after mount, once real DOM measurements exist, is the robust fix —
// this runs inside <ReactFlowProvider>, which is what makes useReactFlow()
// available here.
function FitOnReady({ nodeCount }) {
  const { fitView } = useReactFlow();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || nodeCount === 0) return;
    done.current = true;
    const raf = requestAnimationFrame(() => fitView({ padding: 0.1, duration: 0 }));
    return () => cancelAnimationFrame(raf);
  }, [nodeCount, fitView]);
  return null;
}

// A real node-graph canvas of the real orchestrator (server/agents/
// orchestrator.js + runner.js) — pan/zoom, a dotted graph-paper background,
// elevated node cards, fitted animated connectors — the same visual
// language as n8n/LangGraph Studio/Temporal's workflow UIs, built on React
// Flow. Node dragging is deliberately OFF: there's no backend to persist a
// moved position, and this is a live status view of a fixed real topology,
// not a user-authored workflow — free dragging would just reset on next
// load.
//
// panOnScroll/zoomOnScroll are deliberately OFF: this canvas sits inside a
// normally-scrollable page, and with them on, a plain mouse-wheel scroll
// that merely passes over the canvas gets hijacked into a zoom/pan gesture
// instead of scrolling the page — which is exactly what made the graph
// appear to randomly zoom in and clip content. Deliberate gestures (click-
// drag to pan, trackpad pinch to zoom, or the +/-/fit buttons in Controls)
// still work; only accidental wheel-scroll capture is disabled.
export default function OrchestrationDiagram({ agents, onSelectAgent, runningAgents }) {
  const { nodes, edges } = useMemo(
    () => buildGraph({ agents, runningAgents, onSelectAgent }),
    [agents, runningAgents, onSelectAgent]
  );

  return (
    <div className="relative w-full h-[560px] rounded-3xl overflow-hidden"
      style={{ border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.015)' }}>
      <style>{`
        @keyframes orbitDash { to { stroke-dashoffset: -24; } }
        .orbit-edge { animation: orbitDash 1.4s linear infinite; }
        .orbit-edge-live { animation: orbitDash 0.6s linear infinite; }
        @keyframes nodePulseRing {
          0% { box-shadow: 0 0 0 0 rgba(167,139,250,0.55); }
          100% { box-shadow: 0 0 0 10px rgba(167,139,250,0); }
        }
        @media (prefers-reduced-motion: reduce) { .orbit-edge, .orbit-edge-live { animation: none; } }

        /* Restyle React Flow's default light-theme chrome to match this
           page's dark glass aesthetic instead of clashing with it. */
        .orchestration-flow .react-flow__controls {
          background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
          border-radius: 10px; overflow: hidden; box-shadow: none;
        }
        .orchestration-flow .react-flow__controls-button {
          background: transparent; border-bottom: 1px solid rgba(255,255,255,0.08); fill: rgba(255,255,255,0.6);
        }
        .orchestration-flow .react-flow__controls-button:hover { background: rgba(255,255,255,0.08); }
        .orchestration-flow .react-flow__attribution { display: none; }
      `}</style>

      <ReactFlowProvider>
        <ReactFlow className="orchestration-flow" nodes={nodes} edges={edges}
          nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}
          fitView fitViewOptions={{ padding: 0.1 }}
          nodesDraggable={false} nodesConnectable={false} elementsSelectable={false}
          panOnScroll={false} zoomOnScroll={false} zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
          style={{ background: 'transparent' }}>
          <Background variant="dots" gap={24} size={1} color="rgba(255,255,255,0.08)" />
          <Controls showInteractive={false} position="top-right" />
          <FitOnReady nodeCount={nodes.length} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
