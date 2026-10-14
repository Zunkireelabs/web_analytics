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
import { makeVerification, VERDICT } from '../../agents/lib/verdict.js';

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

// Eyebrow/kicker labels and fine print render below this on purpose — they
// are never the heading/body convention a prose section is held to.
const MIN_CHECKED_FONT_PX = 12;

function isVisuallyHiddenClass(classes) {
  for (const t of classTokens(classes)) {
    if (t === 'sr-only' || t === 'visually-hidden' || t === 'hidden' || t === 'invisible') return true;
  }
  return false;
}

// What the element actually RENDERS as — the computed font-size/weight
// capture.js read off the live DOM (item.style) — never its class tokens.
// null when the item has no computed style, or is hidden / a sub-12px label:
// no honest rendered evidence, so the check abstains for it.
function renderedSignature(item) {
  if (isVisuallyHiddenClass(item.classes)) return null;
  const size = parseFloat(item.style?.fontSize);
  if (!Number.isFinite(size) || size < MIN_CHECKED_FONT_PX) return null;
  return `${Math.round(size)}px/${item.style?.fontWeight ?? ''}`;
}

// The convention (stored class string) a prose item is held to, resolved per
// (tag, section role, page type) — see resolveHeadingClasses.
function conventionFor(profile, page, section, item, bodyConventionClasses) {
  if (item.role === 'heading' || item.role === 'subheading') {
    return resolveHeadingClasses(profile, {
      tag: item.tag, sectionRole: section.role,
      pageType: page.pageType, pageTypePatterns: profile?.pageTypePatterns,
    });
  }
  if (item.role === 'body') return bodyConventionClasses;
  return null;
}

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

  // Rendered signatures of every live prose item that DOES follow its stored
  // convention, keyed by (tag, convention). Empty for a convention nobody on
  // the live site follows — a stale profile, which the drift check below
  // treats as "nothing to hold anyone to".
  const followersByConvention = new Map();
  for (const page of segmentedPages || []) {
    for (const section of page.sections || []) {
      if (!PROSE_LIKE_ROLES.has(section.role)) continue;
      for (const item of section.textHierarchy || []) {
        const conventionClasses = conventionFor(profile, page, section, item, profile?.typography?.body || null);
        const convention = conventionClasses ? classTokens(conventionClasses) : null;
        if (!convention || !convention.size || !overlaps(classTokens(item.classes), convention)) continue;
        const signature = renderedSignature(item);
        if (!signature) continue;
        const key = `${item.tag}|${conventionClasses}`;
        if (!followersByConvention.has(key)) followersByConvention.set(key, new Set());
        followersByConvention.get(key).add(signature);
      }
    }
  }

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

      // 3. TYPOGRAPHY DRIFT — a prose-like heading/body that RENDERS
      // differently (computed font-size/weight) from the elements that
      // follow the site's stored convention on the live pages. Class tokens
      // are never the verdict: the stored profile string is a single
      // snapshot (often `text-3xl md:text-4xl`) while the live site may
      // express the same look with other tokens, or follow a different look
      // entirely. So:
      //   - the convention must actually OCCUR on a live page (followers,
      //     collected up front). A convention nobody on the live site
      //     follows is a stale profile, not drift — abstain;
      //   - an item is drift only when its rendered size/weight differs from
      //     EVERY follower of that convention;
      //   - sr-only/hidden elements and sub-12px labels (eyebrows) have no
      //     rendered prose size to judge and are skipped, as are items with
      //     no computed style.
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
          const conventionClasses = conventionFor(profile, page, section, item, profile?.typography?.body || null);
          const convention = conventionClasses ? classTokens(conventionClasses) : null;
          if (!convention || !convention.size) continue;
          const itemTokens = classTokens(item.classes);
          if (!itemTokens.size || overlaps(itemTokens, convention)) continue;
          const signature = renderedSignature(item);
          if (!signature) continue;
          const followers = followersByConvention.get(`${item.tag}|${conventionClasses}`);
          if (!followers || !followers.size || followers.has(signature)) continue;
          findings.push({
            id: TYPOGRAPHY_FINDING, pageUrl: page.url, pageType: page.pageType,
            sectionRole: section.role, sectionOrder: section.order,
            // outerHtml: same live-captured-anchor discipline as the table
            // finding above.
            evidence: {
              textRole: item.role, sectionClasses: item.classes,
              siteConvention: conventionClasses,
              outerHtml: item.outerHtml || '',
              renderedAs: signature, conventionRendersAs: [...followers],
            },
            verification: makeVerification(VERDICT.CONFIRMED, 'computed-style-vs-live-convention',
              'rendered size/weight differs from every live element following the stored convention'),
          });
        }
      }
    }
  }
  return findings;
}
