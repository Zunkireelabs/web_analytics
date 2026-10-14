import { isExpandStructureRefEnabled, expandStructurePrior } from './expand-structure-spec.js';

// The ONE place that decides whether a tenant gets the shared structure
// reference, and builds its prior. Both consumers (expand-content.js and the
// expand layout composer's handler) call this and nothing else, so opt-in and
// containment are enforced once.
//
// Returns null — never throws — unless ALL of these hold:
//   - the action is expand-content (hard assertion, not a convention)
//   - the tenant has opted in: siteRoot.expandStructureRef === true
//   - a valid shared spec exists
// A null prior means "behave exactly as before this existed".
export async function loadExpandStructurePrior(site, { actionType = 'expand-content', pageType = null, deps = {} } = {}) {
  if (actionType !== 'expand-content') return null;
  if (!isExpandStructureRefEnabled(site)) return null;
  try {
    const getSpec = deps.getSpec || (await import('../../store/expand-structure.js')).getLatestExpandStructureSpec;
    const row = await getSpec();
    if (!row) return null;
    return expandStructurePrior(row.spec, site.url_file_map?.siteRoot?.designProfile, { pageType });
  } catch (err) {
    console.warn(`[expand-structure] site ${site?.id}: could not load the reference, continuing without it: ${err.message}`);
    return null;
  }
}
