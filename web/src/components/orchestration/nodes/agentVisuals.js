import { useEffect, useState } from 'react';
import { ORCH_CATEGORY as CATEGORY } from '../palette.js';
import { timeAgo } from '../../../api.js';

// Distinct per-agent icons (cosmetic only, no data claim) so the 5 SEO-
// category agents don't all render the same 🎯 category glyph — makes 10
// nodes actually scannable as 10 different things instead of 10 identical
// blobs of the same 4 category icons.
export const AGENT_ICON = {
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
// used only while `active` is true (backed by a real in-flight fetch, never
// a decorative timer that outlives the request).
export function useElapsedSeconds(startedAt, active) {
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
export function recencyTier(lastRunAt) {
  if (!lastRunAt) return 'none';
  const ageMs = Date.now() - new Date(lastRunAt).getTime();
  if (ageMs < 60 * 60 * 1000) return 'fresh';
  if (ageMs < 24 * 60 * 60 * 1000) return 'recent';
  return 'stale';
}

// Single source of truth for "what does this agent's status look like right
// now" — category color/icon, recency tier, glow/border strength, and the
// status pill text/color/dot. Extracted out of AgentFlowNode.jsx so any
// other view of the same agent data renders identical status language
// instead of a reinvented parallel version that could drift out of sync.
export function getAgentStatus(agent, { isRunning, elapsed = 0 } = {}) {
  const cat = CATEGORY[agent.category] || CATEGORY.seo;
  const icon = AGENT_ICON[agent.id] || cat.icon;
  const hasRun = !!agent.lastRunAt;
  const isError = hasRun && agent.lastRunStatus !== 'ok';
  const tier = isRunning ? 'running' : recencyTier(agent.lastRunAt);

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
  // Darker variant of statusColor for body text on a light fill — statusColor
  // itself stays as the dot glyph/glow color (works on either background).
  const statusTextColor = isRunning ? '#7c3aed' : isError ? '#b45309' : hasRun ? '#059669' : '#64748b';

  return { cat, icon, hasRun, isError, tier, glow, borderOpacity, cardOpacity, statusText, statusColor, statusDot, statusTextColor };
}
