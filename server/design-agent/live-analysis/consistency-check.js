// Pure comparison: a freshly-segmented live page (segment.js's output) vs.
// the site's own ALREADY-STORED design profile (profile-extract.js's
// output, persisted at site.url_file_map.siteRoot.designProfile). No
// browser, no network, no LLM call — deliberately the same "pure,
// unit-testable" separation segment.js itself keeps from capture.js.
//
// WHAT THIS CLOSES: every existing repair path (repair-site-content-live.js)
// only ever touches SEOAI-marker regions, blog posts, and front matter — a
// hand-written table, a legacy section outside a marker, or a compliance
// page's own body content is invisible to it. This is the missing "does
// this section actually look like the rest of the site" check, run against
// EVERY section of a representative page of every page type the live-
// analysis pipeline already captures (capture.js's discoverPages already
// picks one real URL per PAGE_TYPES entry — homepage, service, location,
// landing, faq, blog-listing, blog-article, legal, other) — so a compliance
// page gets exactly the same scrutiny as a product page, with no special
// case needed.
//
// DELIBERATELY DETECTION-ONLY. Every finding here is real, grounded
// evidence (a real class string that does or doesn't overlap with the
// site's own observed vocabulary) — never a synthesized "here is the
// correct markup" the way marker re-rendering can be, because there is no
// known-correct template for an arbitrary section the way there is for a
// FAQ/Q&A/expand-content marker. See agents/lib/design-consistency.js for
// what happens to a finding from here (a real, human-reviewed Action Center
// recommendation, riskTier 'manual' — same posture as every other
// currently-unactionable-but-real signal in this app, e.g.
// technical-seo.js's Core Web Vitals findings).

import { resolveHeadingClasses } from './heading-context.js';

function classTokens(...classStrings) {
  const set = new Set();
  for (const s of classStrings) {
    if (typeof s !== 'string') continue;
    for (const t of s.trim().split(/\s+/)) if (t) set.add(t);
  }
  return set;
}

function overlaps(a, b) {
  for (const t of a) if (b.has(t)) return true;
  return false;
}

// A class token is "responsive" when it carries one of the site's OWN real
// observed breakpoint prefixes (profile.responsive.breakpoints, e.g.
// ["sm:", "md:", "lg:"] — captured, never invented, same discipline as
// every other profile field). A site that has never once used a responsive
// prefix anywhere has nothing real to hold a section to, so this check is
// silently skipped for such a site rather than inventing a generic
// Tailwind-breakpoint assumption it never earned.
function hasResponsiveToken(tokens, breakpointPrefixes) {
  for (const t of tokens) {
    for (const prefix of breakpointPrefixes) {
      if (t.startsWith(prefix)) return true;
    }
  }
  return false;
}

function allSectionClasses(section) {
  return classTokens(
    section.classes,
    ...(section.textHierarchy || []).map((h) => h.classes),
    ...(section.components || []).map((c) => c.classes),
  );
}

const TABLE_FINDING = 'table-style-drift';
const RESPONSIVE_FINDING = 'missing-responsive-classes';
const TYPOGRAPHY_FINDING = 'typography-drift';

// Section roles a generic typography-drift check is meaningful for — a
// hero/cta/footer legitimately has its own visual treatment that need not
// resemble body copy, so only checking roles whose text is ordinary prose
// avoids a wall of false positives on sections that are SUPPOSED to look
// different.
const PROSE_LIKE_ROLES = new Set(['content', 'faq', 'features', 'testimonials', 'team', 'pricing']);

/**
 * @param profile   the site's stored Design Profile v2 (design-profile.js's
 *                  DESIGN_PROFILE_VERSION shape) — never mutated.
 * @param segmentedPages  segment.js's segmentSite() output for THIS run's
 *                  fresh capture — one entry per page type captured.
 * @returns Finding[] — { id, pageUrl, pageType, sectionRole, sectionOrder, evidence }
 */
export function compareSectionsToProfile(profile, segmentedPages, { responsive = null } = {}) {
  const findings = [];
  // Pages we have REAL responsive measurements for. For those, the
  // class-name heuristic below (finding 2) is switched off entirely and
  // responsive-analysis.js's measured defects stand in its place.
  //
  // This is a strict improvement, not just a swap: "has no breakpoint-prefixed
  // class" was only ever a proxy for "probably breaks on a phone", and it is a
  // bad one in both directions. A section can be perfectly responsive with no
  // prefixed class at all (a plain flex-wrap, a max-width, a CSS grid with
  // auto-fit, or any non-Tailwind stylesheet), and a section covered in
  // md:/lg: classes can still overflow. Measuring the rendered page answers
  // the real question and drops that whole class of false positive.
  const measuredPages = new Set(
    (responsive?.pages || [])
      .filter((p) => Object.keys(p.byViewport || {}).length > 0)
      .map((p) => p.url),
  );
  const breakpointPrefixes = (profile?.responsive?.breakpoints || []).filter((b) => typeof b === 'string' && b);
  const tableConvention = profile?.components?.table?.wrapper ? classTokens(profile.components.table.wrapper) : null;
  const bodyConvention = profile?.typography?.body ? classTokens(profile.typography.body) : null;

  for (const page of segmentedPages || []) {
    for (const section of page.sections || []) {
      const sectionTokens = allSectionClasses(section);

      // 1. TABLE STYLE DRIFT — a real table on this section, but its
      // wrapper class shares nothing with the site's own known table
      // convention. table.classes is capture.js's {wrapper, headerCell,
      // row, cell} shape (segment.js's componentsOf), same shape as
      // profile.components.table itself — .wrapper is the one field both
      // sides are guaranteed to have attempted to fill. Only checked when
      // the profile actually HAS a real table pattern to compare against
      // (a site with no table anywhere else has nothing honest to hold
      // this one to).
      const table = (section.components || []).find((c) => c.type === 'table');
      if (table && tableConvention && tableConvention.size) {
        const tableTokens = classTokens(table.classes?.wrapper);
        if (tableTokens.size && !overlaps(tableTokens, tableConvention)) {
          findings.push({
            id: TABLE_FINDING, pageUrl: page.url, pageType: page.pageType,
            sectionRole: section.role, sectionOrder: section.order,
            // outerHtml is the live-captured anchor a routed fix patches
            // against (see design-consistency.js) — absent (never
            // fabricated) whenever capture.js couldn't resolve a table
            // element to capture it from, which correctly leaves this
            // finding unroutable rather than routed against a guessed anchor.
            evidence: { sectionClasses: table.classes.wrapper, siteConvention: profile.components.table.wrapper, outerHtml: table.outerHtml || '' },
          });
        }
      }

      // 2. MISSING RESPONSIVE CLASSES — this site demonstrably uses
      // breakpoint-prefixed classes elsewhere (breakpointPrefixes is real
      // evidence, not an assumption), but this section has none at all.
      if (!measuredPages.has(page.url)
        && breakpointPrefixes.length && sectionTokens.size && !hasResponsiveToken(sectionTokens, breakpointPrefixes)) {
        findings.push({
          id: RESPONSIVE_FINDING, pageUrl: page.url, pageType: page.pageType,
          sectionRole: section.role, sectionOrder: section.order,
          evidence: { sectionClasses: section.classes, siteBreakpoints: breakpointPrefixes },
        });
      }

      // 3. TYPOGRAPHY DRIFT — a prose-like section whose heading/body text
      // classes share nothing with the site's own real heading/body
      // convention. Checked independently for heading and body since a
      // section can legitimately get one right and the other wrong.
      //
      // A heading's expected classes are resolved per (tag, section.role) —
      // resolveHeadingClasses (heading-context.js) — rather than one flat
      // profile.typography.heading.item, so an h1 belonging to this section
      // (a page whose title lives outside a dedicated hero section, e.g. a
      // legal page) is compared against this site's own real
      // hero-vs-standard evidence instead of the h3-level "item heading"
      // convention that field was actually meant for. Hero sections
      // themselves are never checked here (PROSE_LIKE_ROLES excludes
      // 'hero') — a hero is expected to look different from body prose.
      if (PROSE_LIKE_ROLES.has(section.role)) {
        for (const item of section.textHierarchy || []) {
          let conventionClasses = null;
          let convention = null;
          if (item.role === 'heading' || item.role === 'subheading') {
            conventionClasses = resolveHeadingClasses(profile, {
              tag: item.tag, sectionRole: section.role,
              pageType: page.pageType, pageTypePatterns: profile?.pageTypePatterns,
            });
            convention = conventionClasses ? classTokens(conventionClasses) : null;
          } else if (item.role === 'body') {
            conventionClasses = profile.typography.body || null;
            convention = bodyConvention;
          }
          if (!convention || !convention.size) continue;
          const itemTokens = classTokens(item.classes);
          if (itemTokens.size && !overlaps(itemTokens, convention)) {
            findings.push({
              id: TYPOGRAPHY_FINDING, pageUrl: page.url, pageType: page.pageType,
              sectionRole: section.role, sectionOrder: section.order,
              // outerHtml: same live-captured-anchor discipline as the table
              // finding above.
              evidence: {
                textRole: item.role, sectionClasses: item.classes,
                siteConvention: conventionClasses,
                outerHtml: item.outerHtml || '',
              },
            });
          }
        }
      }
    }
  }
  return findings;
}
