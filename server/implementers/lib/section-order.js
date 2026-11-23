// THE STANDARD PAGE ORDER for generated blocks, applied the same way on every site that opts in:
//
//   main content  ->  expanded content  ->  FAQ  ->  related guides  ->  final call to action  ->  footer
//
// - Expanded content goes just above the FAQ. A page with no FAQ puts it just above the call to action instead.
// - Related guides go just after the FAQ and before the call to action. With no FAQ they sit just before the call to action.
// - A page with neither FAQ nor call to action is left exactly as the engine placed the marker.
//
// ON by default for every site. A site (or one area of a site) is held back with url_file_map.siteRoot.sectionOrder = "off", for example while its
// own owner is still reviewing how generated blocks look there. The rule only ever decides where a NEWLY created marker goes: a marker already on a
// page is never moved, and a page whose sections cannot be told apart is left exactly as the engine placed the marker.
export const STANDARD_SECTION_ORDER = Object.freeze(['content', 'expand-content', 'faq', 'related-guides', 'cta']);

export function usesStandardSectionOrder(site) {
  return site?.url_file_map?.siteRoot?.sectionOrder !== 'off';
}

/** The placement instruction for a marker field, or null when the site is held back (sectionOrder "off") or the field has no ordering rule. */
export function standardPlacementFor(site, actionType, field) {
  if (!site || !usesStandardSectionOrder(site) || !field) return null;
  if (actionType === 'expand-content') return { field, mode: 'before-trailing', beforeRoles: ['faq', 'cta'] };
  if (actionType === 'internal-links') return { field, mode: 'related-guides' };
  return null;
}
