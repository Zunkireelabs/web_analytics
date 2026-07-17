import { Position, MarkerType } from '@xyflow/react';
import { ORCH_CATEGORY as CATEGORY } from './palette.js';

const arrow = (color) => ({ type: MarkerType.ArrowClosed, color, width: 14, height: 14 });

// Real upstream ingest sources (server/ingest/*.js) — shown as one shared
// pool, not wired 1:1 to agents. Precisely which agent reads which source
// (e.g. query-intelligence reads GSC only, technical-seo reads GSC+
// PageSpeed+crawl) is true but would need ~15 crossing lines for one tier —
// accurate in aggregate ("every agent reads from here"), not accurate to
// imply 1:1 wiring that doesn't cleanly exist anyway (most agents read 2-3
// of these). No edges are drawn to/from these nodes; position + the on-canvas
// caption carry that meaning instead.
export const DATA_SOURCES = [
  { id: 'ds-gsc', label: 'Search Console', icon: '🔍' },
  { id: 'ds-ga4', label: 'Analytics 4', icon: '📊' },
  { id: 'ds-crawl', label: 'Live page crawl', icon: '🕷️' },
  { id: 'ds-pagespeed', label: 'PageSpeed Insights', icon: '⚡' },
  { id: 'ds-dataforseo', label: 'DataForSEO (SERP)', icon: '🌎' },
];

const CARD_W = 230;
const SOURCE_H = 40;
const AGENT_H = 128;
const HUB_H = 148;
const HUB_BIG_H = 168;
// Was 108 — *less* than AGENT_H (118 at the time), so agent cards in the
// same sub-column literally overlapped by 10px. Now comfortably taller than
// a card plus a real gap between rows.
const ROW_H = 156;
const AGENT_SUBCOL_GAP = 60; // was 40 — gap between the two agent sub-columns
const COL_GAP = 160;
const COL_X = {
  sources: 0,
  agents: CARD_W + COL_GAP, // first of two agent sub-columns
  store: CARD_W + COL_GAP + (CARD_W + AGENT_SUBCOL_GAP) * 2,
  consumers: CARD_W + COL_GAP + (CARD_W + AGENT_SUBCOL_GAP) * 2 + CARD_W + COL_GAP,
};
const CENTER_Y = 320;

// Evenly spaced y positions for `count` items, vertically centered on
// CENTER_Y — same helper for every column so the whole graph reads as one
// consistent grid regardless of how many nodes are in a given tier.
function columnY(count, rowH = ROW_H) {
  const totalH = (count - 1) * rowH;
  const start = CENTER_Y - totalH / 2;
  return Array.from({ length: count }, (_, i) => start + i * rowH);
}

// The genuinely precise, real part of this graph: server/agents/registry.js
// confirms all 10 specialist agents run independently/in parallel (a
// fan-in, not a chain — none reads another's output) and persist to the
// shared agent_runs table. From there, Command Center and Action Center
// both read that shared store directly, and Executive Report Agent reads 7
// of the 10 (meta.requires) to synthesize one narrative, which itself
// surfaces back on Command Center (the dashed loop-back edge).
const CONSUMERS = [
  { id: 'command-center', icon: '🧭', label: 'Command Center', to: '/ai-growth', color: CATEGORY.seo.color, sub: 'Discoveries, critical issues, recommended actions — from all 10 agents' },
  { id: 'action-center', icon: '⚡', label: 'Action Center', to: '/action-center', color: CATEGORY.content.color, sub: 'Draftable fixes grounded in real findings' },
  { id: 'executive-report', icon: '🧠', label: 'Executive Report', big: true, color: CATEGORY.meta.color, sub: 'Weekly narrative from 7 of 10 agents' },
];

const FINDINGS_STORE = {
  id: 'findings-store', icon: '🗄️', label: 'Findings Store',
  sub: "Every agent's results, persisted — the shared table every page below reads from",
};

// Pure function: (real agent list + real live-run state) -> React Flow
// nodes/edges. No layout state lives in a component — same graph shape
// every render, recomputed from the same real inputs the old diagram used.
export function buildGraph({ agents, runningAgents, onSelectAgent }) {
  const specialists = agents.filter((a) => a.category !== 'meta');
  const executiveReportMeta = agents.find((a) => a.id === 'executive-report');

  const nodes = [];
  const edges = [];

  // Sources are 40px pills, not full agent cards — their own tighter row
  // height instead of inheriting the agent grid's spacing, which would
  // otherwise stretch five small pills across a needlessly tall column.
  const sourceY = columnY(DATA_SOURCES.length, 76);
  DATA_SOURCES.forEach((ds, i) => {
    nodes.push({
      id: ds.id, type: 'hub', draggable: false, connectable: false,
      position: { x: COL_X.sources, y: sourceY[i] },
      width: CARD_W, height: SOURCE_H,
      sourcePosition: Position.Right, targetPosition: Position.Left,
      data: { variant: 'source', icon: ds.icon, label: ds.label },
    });
  });

  const agentRows = Math.ceil(specialists.length / 2);
  const agentY = columnY(agentRows);
  specialists.forEach((agent, i) => {
    const subCol = i % 2;
    const row = Math.floor(i / 2);
    nodes.push({
      id: agent.id, type: 'agent', draggable: false, connectable: false,
      position: { x: COL_X.agents + subCol * (CARD_W + AGENT_SUBCOL_GAP), y: agentY[row] },
      width: CARD_W, height: AGENT_H,
      sourcePosition: Position.Right, targetPosition: Position.Left,
      data: { agent, isRunning: runningAgents.has(agent.id), runStartedAt: runningAgents.get(agent.id) ?? null, onSelect: () => onSelectAgent(agent) },
    });
    edges.push({
      id: `${agent.id}-store`, source: agent.id, target: 'findings-store', type: 'flow',
      data: { live: runningAgents.has(agent.id) },
      markerEnd: arrow(runningAgents.has(agent.id) ? '#a78bfa' : '#6C63FF'),
    });
  });

  nodes.push({
    id: FINDINGS_STORE.id, type: 'hub', draggable: false, connectable: false,
    position: { x: COL_X.store, y: CENTER_Y },
    width: CARD_W, height: HUB_H,
    sourcePosition: Position.Right, targetPosition: Position.Left,
    data: { variant: 'store', icon: FINDINGS_STORE.icon, label: FINDINGS_STORE.label, sub: FINDINGS_STORE.sub },
  });

  // Executive Report is a real agent (agents/executive-report.js) but only
  // shown as a consumer node here if it's actually present in the live
  // agent list — same "never render a node for data that isn't real" rule
  // the old diagram followed with its `{executiveReport && (...)}` guard.
  const consumers = executiveReportMeta ? CONSUMERS : CONSUMERS.filter((c) => c.id !== 'executive-report');
  const consumerY = columnY(consumers.length);
  consumers.forEach((c, i) => {
    nodes.push({
      id: c.id, type: 'hub', draggable: false, connectable: false,
      position: { x: COL_X.consumers, y: consumerY[i] },
      width: CARD_W, height: c.big ? HUB_BIG_H : HUB_H,
      sourcePosition: Position.Right, targetPosition: Position.Left,
      data: {
        variant: 'consumer', icon: c.icon, label: c.label, sub: c.sub, big: c.big, to: c.to, color: c.color,
        onSelect: c.id === 'executive-report' ? () => onSelectAgent(executiveReportMeta) : undefined,
      },
    });
    edges.push({ id: `store-${c.id}`, source: 'findings-store', target: c.id, type: 'flow', data: {}, markerEnd: arrow('#6C63FF') });
  });

  if (executiveReportMeta) {
    edges.push({
      id: 'exec-cc', source: 'executive-report', target: 'command-center', type: 'flow',
      data: { dashed: true, loopBack: true, color: CATEGORY.meta.color },
      markerEnd: arrow(CATEGORY.meta.color),
    });
  }

  return { nodes, edges };
}
