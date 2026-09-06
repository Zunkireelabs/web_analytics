import { listSiblingPages } from '../../store/page-inventory.js';

// Decides what to actually DO about a dead internal link: create the page it
// points at, or strip the link.
//
// The rule is deliberately narrow, and it is a capability question rather
// than a desirability one: a missing page is only ever created when the site
// ALREADY has real sibling pages under the same path prefix. Those siblings
// are the template — the new page is written to match a structure the site
// demonstrably already has, never invented from nothing. With no siblings
// there is no structure to copy, so the honest fix is the old one: remove the
// link (server/generators/broken-link-fix.js).
//
// Why prefix-siblings and not a relevance/impressions score: every other
// signal we could reach for (GSC impressions on the dead URL, slug
// wordiness, how many pages link it) says something about whether the page
// would be VALUABLE, not whether we can write it correctly. Shipping an
// LLM-invented page in a shape the site has never used is exactly the
// "generated content that doesn't match the rest of the site" failure this
// exists to stop, and it is far more damaging than a removed link.
//
// Multi-tenant by construction: siblings come from the site's own
// page_inventory rows and nothing here is keyed to a particular site.

// Two real siblings, not one. A single sibling is as likely to be an
// idiosyncratic one-off as a template, and "match the structure" needs at
// least a pair to corroborate that a shared structure exists at all.
export const MIN_SIBLINGS_TO_CREATE = 2;

// A dead URL directly under the origin ('/foo') has the whole site as its
// "prefix", which would make every page on the site look like its sibling.
// Only pages nested at least one directory deep ('/resources/foo') carry a
// real section prefix, so top-level pages are never auto-created.
export function sectionPrefixFor(href) {
  let parsed;
  try { parsed = new URL(href); } catch { return null; }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  return `${parsed.origin}/${segments.slice(0, -1).join('/')}/`;
}

// The site's own name for the destination, taken from the anchor text it is
// linked with. Preferred over the slug because it is real copy a human wrote,
// not a de-hyphenated guess. Falls back to the slug when every link to it is
// image-only or generically labelled.
const GENERIC_ANCHORS = new Set([
  'read more', 'learn more', 'more', 'here', 'click here', 'this page',
  'link', 'continue reading', 'see more', 'view', 'details',
]);

export function titleForMissingPage(href, anchorTexts = []) {
  const meaningful = anchorTexts
    .map((t) => (t || '').trim())
    .filter((t) => t.length >= 3 && !GENERIC_ANCHORS.has(t.toLowerCase()));
  // Most-repeated anchor wins — the label the site uses consistently is a
  // better title than whichever page happened to be crawled first.
  if (meaningful.length) {
    const counts = new Map();
    for (const t of meaningful) counts.set(t, (counts.get(t) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  }
  try {
    const slug = new URL(href).pathname.split('/').filter(Boolean).pop() || '';
    const words = slug.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim();
    return words ? words.replace(/\b\w/g, (c) => c.toUpperCase()) : null;
  } catch {
    return null;
  }
}

// Returns { action: 'create'|'remove', siblings, title, reason }.
// Never throws — a store failure degrades to 'remove', which is the
// already-safe behaviour this repo shipped before page creation existed.
export async function decideDeadLinkAction(siteId, { href, anchorTexts = [] } = {}) {
  const prefix = sectionPrefixFor(href);
  if (!prefix) {
    return { action: 'remove', siblings: [], title: null, reason: 'top-level path has no section prefix to draw a template from' };
  }

  let siblings = [];
  try {
    siblings = await listSiblingPages(siteId, prefix);
  } catch (err) {
    console.warn(`[agents] dead-link-intent: sibling lookup failed for ${href} — falling back to link removal:`, err.message);
    return { action: 'remove', siblings: [], title: null, reason: 'sibling lookup failed' };
  }

  if (siblings.length < MIN_SIBLINGS_TO_CREATE) {
    return { action: 'remove', siblings, title: null, reason: `only ${siblings.length} live sibling(s) under ${prefix} — no established structure to match` };
  }

  const title = titleForMissingPage(href, anchorTexts);
  if (!title) {
    return { action: 'remove', siblings, title: null, reason: 'no anchor text or usable slug to title the page from' };
  }

  return { action: 'create', siblings, title, reason: `${siblings.length} live sibling pages under ${prefix} establish the structure to match` };
}
