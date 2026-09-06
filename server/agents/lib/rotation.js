// Shared "bounded rotation over a large candidate pool" sort — the core
// logic technical-seo-analysis.js's selectRotationBatch proved first.
// Pages never checked (absent from `checkedAt`) sort first; otherwise
// least-recently-checked first. Pure function over an already-fetched
// Map so callers can back it with whichever store table applies to them
// (technical_seo_checks for technical-seo, agent_page_rotation for every
// other page-level agent) without this function knowing about either.
export function sortByRotation(pages, checkedAt) {
  return [...pages].sort((a, b) => {
    const ta = checkedAt.get(a);
    const tb = checkedAt.get(b);
    if (!ta && !tb) return 0;
    if (!ta) return -1;
    if (!tb) return 1;
    return new Date(ta) - new Date(tb);
  });
}
