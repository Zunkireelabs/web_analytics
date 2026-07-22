// Shared category identity (color/icon/label) used across every agent-
// related card in the app (AgentNode, DiscoveryCard, WatchlistCard, etc.) —
// the component that originally lived alongside this (the flat "click to
// run" agent grid) was superseded by the orchestration diagram
// (components/orchestration/*.jsx) and removed; this export is the only
// piece of this file still in use.
export const CATEGORY = {
  seo:           { label: 'SEO',           icon: '🎯', color: '#6C63FF' },
  geo:           { label: 'Geo',           icon: '🌐', color: '#0ea5e9' },
  content:       { label: 'Content',       icon: '📝', color: '#14b8a6' },
  meta:          { label: 'Executive',     icon: '🧠', color: '#ec4899' },
  accessibility: { label: 'Accessibility', icon: '♿', color: '#f59e0b' },
  security:      { label: 'Security',      icon: '🛡️', color: '#ef4444' },
};
