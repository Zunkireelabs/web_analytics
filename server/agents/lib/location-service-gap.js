// Decides whether a missing location×service data-array entry (the
// `adapter-data-not-ready` gate in recommendation-gates.js) is a genuinely
// autofixable structural gap, or a real dead end that must stay reported
// rather than fabricated. See that gate's own comment for the shape of the
// underlying problem: `data-array-content.js`'s computeScalarFieldChange/
// computeSchemaFieldChange refuse (correctly) to write into a
// `services.<slug>` sub-object that doesn't exist yet on a location — this
// module is what decides whether creating that EMPTY container is safe.
//
// Deliberately narrow: this never invents the CONTENT that goes into the new
// entry. It only ever authorizes creating an empty `{}` shell (see
// implementers/adapters/data-array-content.js's computeLocationServiceBootstrapChange)
// — every real field (title, description, highlights, ...) is then written by
// the SAME generators (expand-content, schema, meta-title, faq) that already
// populate every other location×service page today, using their own
// existing, already-grounded generation logic. That's the same "self-heal
// the container, then let the real pipeline run" shape as the structural
// HTML-marker bootstrap (implementers/lib/insertion-engine.js) — this is its
// data-array-content counterpart, not a competing mechanism.
//
// Evidence is read with the same raw-text-range primitives js-data-splice.js
// itself uses to WRITE — never a full parse/eval of a tenant's own JS data
// file (that file is arbitrary, tenant-owned source; evaluating it would be
// an RCE surface). A miss reads as "can't confirm" and refuses, same
// "no evidence either way -> don't guess" posture as every drop/keep
// decision in recommendation-gates.js itself.
//
// Classification vocabulary (mirrors, does not replace, lib/failure-classification.js's
// FAILURE_CLASS/retry_policy — that module classifies why an APPLY failed;
// this one classifies whether a MISSING DEPENDENCY can be safely resolved
// before an apply is even attempted). SAFE_AUTOFIX/HUMAN_REQUIRED are the
// sibling states other call sites in this codebase already use under those
// names (recommendation-gates.js's drop/blockedReason split) — kept out of
// this module's own two-value vocabulary since this decision only ever has
// the outcomes below.

import { configured as dataForSeoKeywordsConfigured, fetchKeywordIdeas } from '../../ingest/dataforseo-keywords.js';
import { getFileContent } from '../../github/client.js';
import { baseBranch } from '../../implementers/lib/github-ops.js';
import { nestedIdsFromPageUrl } from '../../implementers/adapters/data-array-content.js';
import { findObjectRange, findObjectFieldRange, findArrayFieldRange, findScalarFieldRange } from '../../implementers/adapters/lib/js-data-splice.js';
import { resolveSiteLocations } from './site-locations.js';

export const GAP_CLASS = Object.freeze({
  SAFE_RECOVERY: 'SAFE_RECOVERY',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
});

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rawScalarValue(content, objRange, fieldName, format) {
  const range = findScalarFieldRange(content, objRange, fieldName, format);
  if (!range) return null;
  return content.slice(range.valueStart, range.valueEnd);
}

function rawStringArrayValue(content, objRange, fieldName, format) {
  const range = findArrayFieldRange(content, objRange, fieldName, format);
  if (!range) return [];
  const slice = content.slice(range.start, range.end);
  return [...slice.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
}

function hasNonEmptyNestedField(content, objRange, fieldName, format) {
  const range = findObjectFieldRange(content, objRange, fieldName, format);
  if (!range) return false;
  return content.slice(range.start + 1, range.end).trim().length > 0;
}

// A location is only a legitimate expansion target if the tenant's OWN data
// already declares it as one — never inferred purely from keyword demand.
// Either signal is sufficient:
//   1. it's the tenant's own headquarters (an unambiguous, always-real
//      declaration already present on the location object), or
//   2. it's reachable, in the tenant's own `nearbyCities` graph, from a
//      location that already has real service content — i.e. the tenant has
//      already declared "we serve this area from a place we already serve
//      for real", not merely a place search volume happens to exist for.
function isDeclaredExpansionTarget(content, objRange, config, format) {
  if (/isHeadquarters\s*:\s*true/.test(content.slice(objRange.start, objRange.end))) return true;
  const idField = config.idField || 'id';
  const nearby = rawStringArrayValue(content, objRange, 'nearbyCities', format);
  return nearby.some((neighborId) => {
    const neighborRange = findObjectRange(content, idField, neighborId, format);
    return neighborRange && hasNonEmptyNestedField(content, neighborRange, config.nestedField, format);
  });
}

// Never invent a NEW service category — proof it's a real, currently-shipped
// offering is that `serviceId` already appears as a real nested entry (with
// a title) for at least one OTHER location in this same data file. There is
// no separate business-services config table this platform maintains today,
// so the tenant's own already-published data is the only safe source of
// truth for "do we actually offer this". A miss here is conservative by
// construction: it can only produce a false "not a known offering", never a
// false "is one" that would let a fabricated service through.
function isKnownOffering(content, serviceId) {
  const pattern = new RegExp(`(^|[\\s,{])["']?${escapeRegExp(serviceId)}["']?\\s*:\\s*\\{[^}]*?title\\s*:`, 'm');
  return pattern.test(content);
}

// Real search demand for this exact service+location combination — same
// grounding convention as keyword-demand.js's monthly site-wide check (real
// DataForSEO volume, never an LLM guess), scoped down to the one query pair
// this specific gap needs. Silently unavailable (not an error) when
// DataForSEO isn't configured, same "no fabricated substitute" posture as
// every other DataForSEO caller in this codebase.
async function hasVerifiedSearchDemand(site, serviceLabel, locationName, fetchIdeas) {
  if (!dataForSeoKeywordsConfigured()) return { checked: false, hasDemand: false };
  const seedTerms = [`${serviceLabel} ${locationName}`, `${serviceLabel} in ${locationName}`];
  // This site's own real target market (see migration 159) rather than one
  // global default for every tenant — the place name is already in the seed
  // terms above, so only the site's PRIMARY market is queried here, never
  // the full hybrid set (that would just re-ask the same location-named
  // question against an unrelated global index).
  const { locationCode, languageCode } = resolveSiteLocations(site)[0];
  const ideas = await fetchIdeas(seedTerms, { locationCode, languageCode }).catch(() => []);
  const hasDemand = ideas.some((idea) => idea.searchVolume > 0);
  return { checked: true, hasDemand, topVolume: ideas[0]?.searchVolume ?? null };
}

// Evaluates one location×service gap for one site. `config` is the already-
// resolved data-array-content adapter config (dataFile/idField/nestedField/
// format) for whichever generator first hit `adapter-data-not-ready` —
// captured by the caller (recommendation-gates.js), never re-derived here,
// so this module carries no per-tenant file-path knowledge of its own and no
// site_id-keyed branching: every check below operates purely on the site's
// own config object and its own repo content.
export async function evaluateLocationServiceGap(site, page, config, deps = {}) {
  const { fetchFile = getFileContent, beforeRef = baseBranch(site), fetchIdeas = fetchKeywordIdeas } = deps;
  const { id: locationId, nestedId: serviceId } = nestedIdsFromPageUrl(page);
  if (!locationId || !serviceId || !config.nestedField) {
    return { verdict: GAP_CLASS.INSUFFICIENT_DATA, reason: 'could-not-derive-location-service-pair' };
  }

  const file = await fetchFile(site, config.dataFile, beforeRef);
  if (!file) return { verdict: GAP_CLASS.INSUFFICIENT_DATA, reason: 'data-file-not-found' };

  const { content } = file;
  const format = config.format || 'js-export-array';
  const idField = config.idField || 'id';
  const objRange = findObjectRange(content, idField, locationId, format);
  if (!objRange) {
    // The location itself doesn't exist at all — creating a brand-new
    // location entry needs real address/contact/regional facts this module
    // has no safe source for (see module doc comment: never invent local
    // business facts). Out of scope by design, not a coverage gap.
    return { verdict: GAP_CLASS.INSUFFICIENT_DATA, reason: 'location-entry-does-not-exist' };
  }

  const servicesRange = findObjectFieldRange(content, objRange, config.nestedField, format);
  if (servicesRange && findObjectFieldRange(content, servicesRange, serviceId, format)) {
    return { verdict: GAP_CLASS.INSUFFICIENT_DATA, reason: 'already-exists' };
  }

  if (!isKnownOffering(content, serviceId)) {
    return { verdict: GAP_CLASS.INSUFFICIENT_DATA, reason: 'service-not-a-known-offering' };
  }

  if (!isDeclaredExpansionTarget(content, objRange, config, format)) {
    return { verdict: GAP_CLASS.INSUFFICIENT_DATA, reason: 'location-not-a-declared-expansion-target' };
  }

  const locationName = rawScalarValue(content, objRange, 'name', format) || locationId;
  const serviceLabel = serviceId.replace(/-/g, ' ');
  const demand = await hasVerifiedSearchDemand(site, serviceLabel, locationName, fetchIdeas);
  if (!demand.checked || !demand.hasDemand) {
    return { verdict: GAP_CLASS.INSUFFICIENT_DATA, reason: demand.checked ? 'no-verified-search-demand' : 'search-demand-not-checkable' };
  }

  return {
    verdict: GAP_CLASS.SAFE_RECOVERY,
    reason: 'declared-expansion-target-with-known-offering-and-real-demand',
    evidence: { locationId, serviceId, locationName, searchVolume: demand.topVolume },
  };
}
