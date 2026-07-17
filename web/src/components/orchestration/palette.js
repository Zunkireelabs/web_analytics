import { CATEGORY } from '../AgentCard.jsx';

// Orchestration-page-local category palette. Same 4 categories as the
// shared CATEGORY (used app-wide — Command Center's ActivityFeed,
// DiscoveryCard, CriticalIssueCard, etc. all still use CATEGORY's magenta
// for `meta`), but with `meta` swapped to a violet that sits on the same
// indigo -> teal -> violet hue path as the rest of this page's signal
// colors instead of jumping to an unrelated magenta. Scoped to this one
// file rather than changed in the shared CATEGORY so the rest of the app
// (which already has that magenta convention baked into several
// duplicated CATEGORY_META literals) is untouched.
export const ORCH_CATEGORY = {
  ...CATEGORY,
  meta: { ...CATEGORY.meta, color: '#7c3aed' },
};
