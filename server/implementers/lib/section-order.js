// THE STANDARD PAGE ORDER for generated blocks, applied the same way on every site that opts in:
//
//   main content  ->  expanded content  ->  FAQ  ->  related guides  ->  final call to action  ->  footer
//
// - Expanded content goes just above the FAQ. A page with no FAQ puts it just above the call to action instead.
// - Related guides go just after the FAQ and before the call to action. With no FAQ they sit just before the call to action.
// - A page with neither FAQ nor call to action is left exactly as the engine placed the marker.
//
// Opt-in per site (and per area) with url_file_map.siteRoot.sectionOrder = "standard". A site that has not opted in behaves exactly as before,
// so turning this on is a deliberate, reviewed map change, never a silent change of where content lands.
export const STANDARD_SECTION_ORDER = Object.freeze(['content', 'expand-content', 'faq', 'related-guides', 'cta']);

export function usesStandardSectionOrder(site) {
  return site?.url_file_map?.siteRoot?.sectionOrder === 'standard';
}

/** The placement instruction for a marker field, or null when the site has not opted in or the field has no ordering rule. */
export function standardPlacementFor(site, actionType, field) {
  if (!usesStandardSectionOrder(site) || !field) return null;
  if (actionType === 'expand-content') return { field, mode: 'before-trailing', beforeRoles: ['faq', 'cta'] };
  if (actionType === 'internal-links') return { field, mode: 'related-guides' };
  return null;
}
