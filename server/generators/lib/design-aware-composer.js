import { pageTemplateGuidanceText } from '../../design-agent/lib/page-templates.js';

// THE SHARED DESIGN-AWARE COMPOSER.
//
// Every design-sensitive generator that produces NET-NEW page content
// (landing-page, blog-outline, direct-answer, translation, …) decides its
// own STRUCTURE — headline, how many sections, whether there's a
// testimonials/pricing/FAQ-shaped block, where the CTA sits — purely from an
// LLM prompt with zero awareness of how this SITE actually organizes a page
// of that type. design-agent/lib/design-profile.js's projectors (projectCta,
// projectCard, projectPageWrapper) already give the RENDERED output the
// site's real button/card/prose classes — but that only restyles whatever
// generic shape the LLM invented; it never told the LLM what shape to invent
// in the first place. Two sites with wildly different real page conventions
// (a site whose service pages are hero -> 3 feature cards -> pricing -> FAQ,
// vs one that's hero -> long-form prose -> CTA) get IDENTICAL generated
// structure today.
//
// This module closes that gap for GENERATION, not rendering: it turns a
// site's real, observed `pageTypePatterns` (server/design-agent/live-analysis/
// schema.js, captured by live-site analysis — never invented) into grounded
// natural-language guidance a generator's own prompt can include. Every
// generator stays free to write whatever COPY fits its target; what this
// composer constrains is SHAPE — section count and ordering, which text
// roles the site actually uses (eyebrow/heading/subheading/body/cta) — so a
// generated page structurally resembles this site's real pages of that type
// instead of an unrelated generic template.
//
// GROUNDING RULE (same as design-profile.js's projectors): every fact in the
// guidance string traces back to a real value captured on THIS site's own
// live pages. No page type observed on this site -> no guidance -> the
// caller's existing (pre-this-module) prompt, unchanged. This module never
// fabricates a structure for a page type the site has never shown; it only
// ever describes what IS there.
//
// CANONICAL-FIRST. If the site already has a persisted canonical page
// template for this type (design-agent/lib/page-templates.js — normally
// resolved/composed once by routes/action-center.js's generateDraft, BEFORE
// the generator runs), that stable, previously-established template is used
// verbatim: this is what makes the TENTH landing page structurally match the
// FIRST one, rather than each generation re-deriving its own guidance from
// whatever the live profile happens to say at that moment. Only when no
// canonical entry exists yet (a direct generate() call outside generateDraft,
// e.g. the MCP tool or a test) does this fall back to deriving guidance
// live from pageTypePatterns, exactly as it always did — never a behavior
// regression for a caller that never resolved a canonical template.
// One page's OWN captured design, by its exact address. Sites whose pages do not share a template
// (each page has its own sections, widths and spacing) are not described by a page-TYPE average:
// when the target page is one the capture recorded, its own sections lead.
const pathOf = (u) => {
  try { return new URL(u, 'https://placeholder.invalid').pathname.replace(/\/+$/, '') || '/'; } catch { return null; }
};
export function ownPageGuidance(site, pageUrl) {
  if (!pageUrl) return null;
  const want = pathOf(pageUrl);
  const pages = site?.url_file_map?.siteRoot?.designProfile?.pages;
  if (!want || !Array.isArray(pages)) return null;
  const page = pages.find((p) => p?.url && pathOf(p.url) === want && Array.isArray(p.sections) && p.sections.length);
  if (!page) return null;
  const body = page.sections.filter((sec) => sec.role !== 'nav' && sec.role !== 'footer');
  if (!body.length) return null;
  const parts = body.map((sec) => {
    const bits = [sec.role];
    if (sec.width) bits.push(sec.width);
    if (sec.alignment) bits.push(sec.alignment);
    const comps = [...new Set((sec.components || []).map((c) => c.type).filter(Boolean))];
    if (comps.length) bits.push(`with ${comps.join('/')}`);
    const gap = sec.spacing?.after;
    if (Number.isFinite(gap) && gap > 0) bits.push(`${gap}px below`); // 0 is "no measured gap", not a rule to follow
    return bits.join(' ');
  });
  return `This exact page (${want}) was captured on its own, and its design is not assumed to match other pages. Its sections, in order: ${parts.join(' -> ')}. Match THIS page's structure, widths and spacing rhythm for anything added to it.`;
}

export function pageStructureGuidance(site, pageType, { fallbackPageTypes = [], pageUrl = null } = {}) {
  const own = ownPageGuidance(site, pageUrl);
  if (own) return own;
  const candidates = [pageType, ...fallbackPageTypes].filter(Boolean);
  const canonicalTemplates = site?.url_file_map?.siteRoot?.pageTemplates;
  if (canonicalTemplates && typeof canonicalTemplates === 'object') {
    for (const type of candidates) {
      const canonical = canonicalTemplates[type];
      if (canonical && (canonical.sectionOrder?.length || canonical.textRoles?.length)) {
        return pageTemplateGuidanceText(canonical);
      }
    }
  }

  const patterns = site?.url_file_map?.siteRoot?.designProfile?.pageTypePatterns;
  if (!patterns || typeof patterns !== 'object') return null;

  let matched = null;
  let matchedType = null;
  for (const type of candidates) {
    const p = patterns[type];
    if (p && (p.sectionOrder?.length || p.textHierarchy?.length)) {
      matched = p;
      matchedType = type;
      break;
    }
  }
  if (!matched) return null;

  const lines = [`This site's own real "${matchedType}" pages follow this structure — match it where the target content allows, rather than inventing an unrelated layout:`];
  if (matched.sectionOrder?.length) {
    lines.push(`Section order: ${matched.sectionOrder.join(' -> ')}.`);
  }
  const roles = [...new Set((matched.textHierarchy || []).map((h) => h.role).filter(Boolean))];
  if (roles.length) {
    lines.push(`Text roles this site actually uses on such pages: ${roles.join(', ')}.`);
  }
  if (matched.notes) {
    lines.push(`Notes from the site's own real pages: ${matched.notes}`);
  }
  return lines.join(' ');
}

// Whether a site has ANY usable structural guidance at all — lets a
// generator log/report "used design context" vs "no profile yet, fell back
// to its own generic default" without duplicating the lookup above.
export function hasPageStructureGuidance(site, pageType, opts) {
  return pageStructureGuidance(site, pageType, opts) !== null;
}
