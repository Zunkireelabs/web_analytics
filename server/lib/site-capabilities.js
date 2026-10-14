// Computes which data capabilities a site actually has, from its own row —
// the single source of truth server/agents/runner.js checks each agent's
// meta.requiresCapabilities against before running it (see runner.js).
//
// Deliberately generic: 'product' here means "property_type = product",
// never a specific product. A future non-Zenly product tenant gets the same
// capability set from the same row shape.
export function computeSiteCapabilities(site) {
  const capabilities = new Set();
  if (site?.gsc_property) capabilities.add('gsc');
  if (site?.ga4_property_id) capabilities.add('ga4');
  // 'public-web': the tenant has a public site the live-page agents can fetch
  // (crawl, headers, rendered HTML). Deliberately NOT keyed on property_type:
  // a product tenant's marketing site is a real public site and these agents
  // are exactly what make it visible. A login-walled product with no public
  // domain has none, so those agents are never scheduled for it. Same domain
  // sources agents/lib/site-domain.js already resolves from.
  if (site?.website_domain || site?.gsc_property) capabilities.add('public-web');
  return capabilities;
}

export function hasRequiredCapabilities(site, requiresCapabilities) {
  if (!requiresCapabilities?.length) return true;
  const capabilities = computeSiteCapabilities(site);
  return requiresCapabilities.every((c) => capabilities.has(c));
}
