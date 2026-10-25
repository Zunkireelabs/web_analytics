// Shared category identity (color/icon/label) used across every agent-
// related card in the app (AgentNode, DiscoveryCard, WatchlistCard, etc.) —
// the component that originally lived alongside this (the flat "click to
// run" agent grid) was superseded by the orchestration diagram
// (components/orchestration/*.jsx) and removed; this export is the only
// piece of this file still in use.
import { SERIES } from '../lib/palette.js';

export const CATEGORY = {
  seo:           { label: 'SEO',           icon: '🎯', color: SERIES[0] },
  geo:           { label: 'Geo',           icon: '🌐', color: SERIES[1] },
  content:       { label: 'Content',       icon: '📝', color: SERIES[2] },
  meta:          { label: 'Executive',     icon: '🧠', color: SERIES[3] },
  accessibility: { label: 'Accessibility', icon: '♿', color: SERIES[4] },
  security:      { label: 'Security',      icon: '🛡️', color: SERIES[5] },
};
