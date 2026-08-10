// Reads a site's real, staff-confirmed author identity (sites.author_name/
// author_role/author_url/require_visible_byline, migration 090) and turns
// it into the shapes schema.js (a JSON-LD Person) and expand-content.js (a
// deterministic on-page byline section) each need — one read path so both
// generators agree on what "the site's configured author" means, instead of
// each re-deriving it. Every field falls back to null/false when nothing is
// configured, which both callers already treat as "fall back to the
// existing LLM-placeholder behavior" — nothing here changes what happens
// for a site with no profile set.

export function hasAuthorProfile(site) {
  return !!(site?.author_name && site.author_name.trim());
}

// The real, structured author.name/jobTitle/url a search engine can trust —
// deliberately never invented from page text (schema.js's own PLACEHOLDER_
// NOTE convention already refuses to guess this), only ever this
// staff-confirmed fact.
export function authorJsonLd(site) {
  if (!hasAuthorProfile(site)) return null;
  const person = { '@type': 'Person', name: site.author_name.trim() };
  if (site.author_role) person.jobTitle = site.author_role.trim();
  if (site.author_url) person.url = site.author_url;
  return person;
}

// A real, publishable "By <Name>, <Role>" line — only drafted when the site
// has both a real name configured AND its own policy (require_visible_
// byline) actually wants one on the page, not just in schema.
export function authorByline(site) {
  if (!hasAuthorProfile(site) || !site.require_visible_byline) return null;
  const roleSuffix = site.author_role ? `, ${site.author_role.trim()}` : '';
  return `By ${site.author_name.trim()}${roleSuffix}`;
}
