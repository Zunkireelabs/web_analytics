// Drafts the structural fix for a location×service page whose
// `services.<serviceId>` entry doesn't exist yet in the tenant's own data
// file — see agents/lib/location-service-gap.js for the evidence/decision
// logic (only ever reached once that module has confirmed SAFE_RECOVERY:
// a real, already-offered service, a tenant-declared expansion location,
// and verified search demand) and implementers/adapters/data-array-content.js's
// computeLocationServiceBootstrapChange for what actually gets written — an
// EMPTY `{}` container, never content. This generator's only job is to
// re-verify that decision is still current (the repo can have changed since
// the recommendation was created) and hand the implementer the base adapter
// config it needs; it invents no page content itself.
//
// Multi-tenant by construction: every value below (dataFile, ids, evidence)
// comes from `params`, itself built from the site's own config and content
// by recommendation-gates.js — there is no site-specific branch here, and a
// newly onboarded tenant gets the identical behavior the moment its own
// url_file_map has a nestedField-shaped data-array-content adapter for any
// location×service action type.

import { getSiteById } from '../store/read.js';
import { evaluateLocationServiceGap, GAP_CLASS } from '../agents/lib/location-service-gap.js';

export const meta = {
  id: 'location-service-bootstrap',
  name: 'Location × Service Structural Bootstrap',
  description: 'Creates the missing (empty) services.<id> container for a real, evidence-qualified location×service page, so the normal content generators can populate it.',
  recommendationTags: [],
};

// params: { page: string, baseConfig: { dataFile, idField?, nestedField, format? } }
export async function generate({ siteId, params }) {
  const { page, baseConfig } = params || {};
  if (!page || !baseConfig?.dataFile || !baseConfig?.nestedField) {
    throw Object.assign(new Error('page and baseConfig (dataFile/nestedField) are required'), { status: 400 });
  }

  const site = await getSiteById(siteId);
  if (!site) throw Object.assign(new Error('Site not found'), { status: 404 });

  // Re-check live, same "stale: true" refusal convention as canonical.js/
  // schema.js's own already-fixed guards — the gap this recommendation was
  // opened for can have closed (someone shipped it manually, or a prior
  // bootstrap draft already landed) or stopped qualifying (demand dried up,
  // the service was removed elsewhere) since detection time.
  const verdict = await evaluateLocationServiceGap(site, page, baseConfig);
  if (verdict.verdict !== GAP_CLASS.SAFE_RECOVERY) {
    throw Object.assign(
      new Error(`This location×service gap no longer qualifies for automatic recovery (${verdict.reason}) — refusing to draft a structural change without current evidence.`),
      { status: 400, userFacing: true, refusal: true, stale: true },
    );
  }

  return {
    content: { page, baseConfig, evidence: verdict.evidence },
    summary: `Create missing content container for ${verdict.evidence.serviceId} in ${verdict.evidence.locationName} (verified demand: ~${verdict.evidence.searchVolume}/mo)`,
  };
}
