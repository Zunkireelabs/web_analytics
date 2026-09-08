// CANONICAL PAGE TEMPLATES — the page-TYPE-level counterpart to
// design-profile.js's componentTemplates (faq/expand-content/qa-content/
// internal-links/content-wrapper). componentTemplates already implements
// "first use composes a real, grounded template; every later use of the
// same type reuses it" — but only for those five COMPONENT concepts.
// Net-new WHOLE PAGES (landing-page, blog-outline, direct-answer,
// translation, …) had no such persisted canonical shape at all: every
// generation call re-derived structural guidance straight from the live
// design profile (see design-aware-composer.js's pageStructureGuidance),
// which is grounded and site-native but never STABLE — two pages generated
// minutes apart could in principle read a profile that changed between
// them, and there was nothing a later generation of the same type could be
// said to be "reusing".
//
// This module is that missing persistence layer:
//
//   FIRST page of a type   -> compose a canonical template from the site's
//                              real, live-observed pageTypePatterns, persist
//                              it under url_file_map.siteRoot.pageTemplates.
//   LATER pages of a type  -> read the persisted canonical template
//                              directly — no re-derivation, no drift between
//                              two pages of the same type generated on
//                              different days.
//   Weekly Design Agent rescan -> invalidates it automatically. Every
//                              canonical entry is stamped with the design
//                              profile's OWN `derivedAt` at compose time
//                              (`derivedFromProfileVersion`). A rescan that
//                              re-derives the profile changes `derivedAt`;
//                              the next resolve call for that page type sees
//                              the stamp no longer matches and recomposes —
//                              structural, not a separate invalidation step
//                              that could be forgotten or fall out of sync
//                              with what the profile actually says now.
//
// GROUNDING RULE — same discipline as design-profile.js's projectors and
// design-aware-composer.js's pageStructureGuidance: every fact in a
// canonical template traces back to a real value this site's OWN live pages
// showed the Design Agent. No real pattern for a page type -> no canonical
// template -> the caller's pre-existing (ungrounded) behavior, unchanged.
// This module never invents a structure for a page type the site has never
// shown.
import { updateSiteRepoConfig } from '../../db.js';

export const PAGE_TEMPLATE_VERSION = 1;

// generatorId -> the PAGE_TYPES (live-analysis/schema.js) it produces, most
// specific first — mirrors design-aware-composer.js's own fallback chains so
// the canonical template a generator gets is derived the same way its
// per-call guidance always was. Extend this map, not the resolve function
// below, when wiring a new generator in.
export const PAGE_TEMPLATE_TYPES_FOR_GENERATOR = Object.freeze({
  'landing-page': ['landing', 'service', 'homepage'],
  'blog-outline': ['blog-article', 'blog-listing'],
  'direct-answer': ['faq', 'other'],
  translation: ['other'],
});

function firstMatchingPattern(patterns, candidateTypes) {
  for (const type of candidateTypes) {
    const p = patterns?.[type];
    if (p && (p.sectionOrder?.length || p.textHierarchy?.length)) return { type, pattern: p };
  }
  return null;
}

// The site's OWN most-established page shape, whatever page type it happens
// to belong to — the widest real evidence available about how this site
// builds a page. Picked by section count as a proxy for "most fully
// developed", so a rich service/landing page wins over a thin one-section
// page that happens to sort first.
// Inference needs a real design language to copy, not a scrap. A pattern of
// one lone section describes almost nothing about how this site builds a
// page, and treating it as the canonical shape for a whole new page type
// would be inventing a structure while appearing to be grounded — exactly
// what this module's grounding rule forbids. Below this floor there is no
// usable evidence and the honest answer is still to refuse.
const MIN_SECTIONS_TO_INFER_FROM = 2;

function mostEstablishedPattern(patterns) {
  let best = null;
  for (const [type, p] of Object.entries(patterns || {})) {
    if (!p?.sectionOrder?.length || p.sectionOrder.length < MIN_SECTIONS_TO_INFER_FROM) continue;
    if (!best || p.sectionOrder.length > best.pattern.sectionOrder.length) best = { type, pattern: p };
  }
  return best;
}

// A site with no observed pattern for the requested page type used to get
// NOTHING — resolveOrCreateCanonicalPageTemplate returned
// 'no-real-pattern-for-type', pageStructureGuidance returned null, and the
// generator fell back to inventing its own generic shape. That is the exact
// failure behind "the site has no blog template, so the first blog looks
// like a generic AI page instead of part of this website".
//
// A site that has never published a blog still HAS a design language: the
// section rhythm, text-role vocabulary and heading hierarchy every one of
// its other pages already uses. Inferring the new page type's shape from
// that is still grounded — every value below is copied from a real observed
// pattern on THIS site, never invented — it is simply grounded in the
// site's other pages rather than in pages of this type, which do not exist
// yet. `inferredFrom` records that honestly so the provenance is never
// mistaken for a direct observation of this page type.
function inferTemplateFromDesignLanguage(patterns, requestedType) {
  const source = mostEstablishedPattern(patterns);
  if (!source) return null;
  const textRoles = [...new Set((source.pattern.textHierarchy || []).map((h) => h.role).filter(Boolean))];
  if (!source.pattern.sectionOrder?.length && !textRoles.length) return null;
  return {
    type: requestedType,
    pattern: {
      sectionOrder: source.pattern.sectionOrder || [],
      textHierarchy: source.pattern.textHierarchy || [],
      notes: `Inferred from this site's own "${source.type}" pages — the site has no published "${requestedType}" page yet, so its established design language is the grounding.`,
    },
    inferredFrom: source.type,
  };
}

/**
 * Compose (on first use) or reuse (on every later use) this site's canonical
 * page template for one page TYPE — not one generatorId, so two generators
 * that resolve to the same real pattern (e.g. a future 'service-page'
 * generator falling onto 'service', same as landing-page's fallback) share
 * one canonical entry rather than each maintaining an independent copy.
 *
 * @param {object} site
 * @param {string[]} candidateTypes — page types to try, most specific first
 *   (see PAGE_TEMPLATE_TYPES_FOR_GENERATOR).
 * @param {object} [opts]
 * @returns {{ ok: boolean, reason?: string, template: object|null, source?: 'existing'|'composed' }}
 */
export async function resolveOrCreateCanonicalPageTemplate(site, candidateTypes, {
  saveConfig = updateSiteRepoConfig,
} = {}) {
  const profile = site?.url_file_map?.siteRoot?.designProfile;
  const patterns = profile?.pageTypePatterns;
  const existingTemplates = site?.url_file_map?.siteRoot?.pageTemplates || {};

  if (!patterns) return { ok: false, reason: 'no-design-profile', template: null };

  // What the BEST real pattern match is RIGHT NOW, most-specific-first —
  // decided before ever looking at what happens to already be persisted, so
  // a site that has since grown a real 'landing' pattern (after its
  // canonical template was first composed from a 'service' fallback) is
  // never stuck reusing the less-specific fallback just because an entry
  // for it happens to exist. Only THIS type's own persisted entry is ever a
  // reuse candidate.
  // Direct observation of this page type first; only when the site has
  // genuinely never published one do we fall back to inferring its shape
  // from the site's own established design language (see
  // inferTemplateFromDesignLanguage). Inference is deliberately the second
  // choice, never a shortcut past real evidence.
  const match = firstMatchingPattern(patterns, candidateTypes)
    || inferTemplateFromDesignLanguage(patterns, candidateTypes[0]);
  if (!match) return { ok: false, reason: 'no-real-pattern-for-type', template: null };

  const existing = existingTemplates[match.type];
  if (existing && profile.derivedAt && existing.derivedFromProfileVersion === profile.derivedAt) {
    return { ok: true, template: existing, source: 'existing', pageType: match.type };
  }

  // A stale canonical entry for this exact type IS invalidated here — a
  // weekly rescan that re-derived the profile changed `derivedAt`, the
  // fresh-check above found no match, and this compose step naturally
  // overwrites the old entry with one grounded in the site's CURRENT design,
  // never leaving the old, possibly-now-wrong template in place alongside
  // the new one.
  const canonical = {
    version: PAGE_TEMPLATE_VERSION,
    pageType: match.type,
    sectionOrder: match.pattern.sectionOrder || [],
    textRoles: [...new Set((match.pattern.textHierarchy || []).map((h) => h.role).filter(Boolean))],
    notes: match.pattern.notes || null,
    // Honest provenance: set only when this shape came from the site's OTHER
    // page types rather than from real pages of this one. Persisted like any
    // other canonical entry, so the FIRST page of a new type establishes the
    // template and every later page of that type reuses it — the site grows
    // its own blog/resources convention instead of re-inventing one per page.
    ...(match.inferredFrom ? { inferredFromPageType: match.inferredFrom } : {}),
    derivedFromProfileVersion: profile.derivedAt,
    derivedAt: new Date().toISOString(),
  };

  const urlFileMap = {
    ...site.url_file_map,
    siteRoot: {
      ...site.url_file_map?.siteRoot,
      pageTemplates: { ...existingTemplates, [match.type]: canonical },
    },
  };
  await saveConfig({ siteId: site.id, urlFileMap });

  return { ok: true, template: canonical, source: 'composed', pageType: match.type };
}

/**
 * Render a canonical page template as the same grounded guidance string
 * design-aware-composer.js's pageStructureGuidance produces — so a
 * generator's prompt reads identically whether the guidance came from a
 * freshly-composed canonical template or a reused one.
 */
export function pageTemplateGuidanceText(template) {
  if (!template) return null;
  const lines = [template.inferredFromPageType
    // The site has no page of this type yet, so the instruction is not
    // "copy this type's pages" but "build the first one out of the design
    // language the rest of the site already established".
    ? `This site has no published "${template.pageType}" page yet. Build this one so it belongs to the site: follow the same structure its own "${template.inferredFromPageType}" pages use, rather than inventing a generic layout:`
    : `This site's own real "${template.pageType}" pages follow this structure — match it where the target content allows, rather than inventing an unrelated layout:`];
  if (template.sectionOrder?.length) lines.push(`Section order: ${template.sectionOrder.join(' -> ')}.`);
  if (template.textRoles?.length) lines.push(`Text roles this site actually uses on such pages: ${template.textRoles.join(', ')}.`);
  if (template.notes) lines.push(`Notes from the site's own real pages: ${template.notes}`);
  return lines.join(' ');
}
