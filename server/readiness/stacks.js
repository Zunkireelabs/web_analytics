// What differs by stack, kept small and explicit. Everything else in the readiness run is stack-agnostic.
//
// A marker can be absent for a GOOD reason: some stacks build the page's Open Graph and canonical tags in ONE shared layout from the page's own title
// and description (Astro, Next metadata helpers, many Hugo themes). There is then no per-page tag to mark; fixing the title/description updates them.
// That is a stated "not applicable", never a silent skip, and it is only claimed when the layout file really builds those tags from variables.

export const NOT_APPLICABLE = Object.freeze({ DERIVED_BY_LAYOUT: 'derived-by-the-shared-layout' });

// Does the shared layout build these head tags from variables (so a per-page tag does not exist)? Read from the layout's own text.
export function layoutDerivesHead(layoutContent) {
  const t = String(layoutContent || '');
  return {
    OPENGRAPH: /og:title["'][^>\n]*(\{|\$\{|\{\{)/.test(t),
    CANONICAL: /rel=["']canonical["'][^>\n]*(\{|\$\{|\{\{)/.test(t) || /canonical\s*[:=]/.test(t) && /<link[^>]*canonical/i.test(t),
  };
}

// Splits plan gaps into the ones that are genuinely open and the ones that are not applicable for a stated reason.
// `exclusions` are the OWNER's decisions, kept in the site's own mapping (url_file_map.siteRoot.readiness.exclusions): `{ marker, match, reason }` means
// "this marker is not wanted on pages whose address matches `match`, because `reason`". They turn a gap into a stated not-applicable; they never hide one.
export function classifyGaps(gaps, { layoutDerives = {}, derivesFor = null, exclusions = [] } = {}) {
  const open = []; const notApplicable = [];
  const excluded = (g) => exclusions.find((x) => x.marker === g.marker && x.reason && (() => { try { return new RegExp(x.match).test(new URL(g.page).pathname); } catch { return false; } })());
  for (const g of gaps) {
    const ex = excluded(g);
    if (ex) { notApplicable.push({ ...g, reason: `excluded by the owner: ${ex.reason}` }); continue; }
    const derives = derivesFor ? (derivesFor(g) || {}) : layoutDerives;
    // A head marker the planner could not place, or would only have created by adding an empty front-matter value (`canonicalUrl: ""`) that a layout which
    // builds its own canonical never reads: both mean "there is no per-page tag here".
    const headReason = ['no-head-region', 'not-placed', 'no-front-matter'].includes(g.reason) || /^creating it would add a value/.test(g.reason);
    if ((g.marker === 'OPENGRAPH' || g.marker === 'CANONICAL') && derives[g.marker] && headReason) notApplicable.push({ ...g, reason: NOT_APPLICABLE.DERIVED_BY_LAYOUT });
    else open.push(g);
  }
  return { open, notApplicable };
}

// Same shape as the gap lists: grouped by marker and reason with a few examples, for a report a person can read.
export function groupGaps(items, examples = 3) {
  const groups = new Map();
  for (const g of items) {
    const key = `${g.marker}|${g.reason}`;
    const e = groups.get(key) || { marker: g.marker, reason: g.reason, count: 0, pages: new Set(), examples: [] };
    e.pages.add(g.page); e.count++;
    if (e.examples.length < examples && !e.examples.includes(g.page)) e.examples.push(g.page);
    groups.set(key, e);
  }
  return [...groups.values()].map(({ pages, ...rest }) => ({ ...rest, pages: pages.size })).sort((a, b) => b.pages - a.pages);
}
