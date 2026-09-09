// Pure analysis of capture.js's multi-viewport measurements. No browser, no
// network, no LLM — the same separation segment.js keeps from capture.js, and
// for the same reason: the measuring has to happen in a real page, but
// deciding what the measurements MEAN is ordinary logic that should be
// unit-testable without launching anything.
//
// Two outputs, deliberately separate:
//
//   summarizeResponsive()   -> facts for Design Memory. What this site DOES at
//                              each width. Descriptive, never a judgement.
//   detectResponsiveIssues() -> findings. Where a page is actually broken.
//
// The distinction matters because the profile is consumed by generators
// deciding how to render new content (they need to know this site stacks at
// mobile and drops its nav behind a toggle), while findings are consumed by
// the recommendation pipeline (which needs to know THIS page overflows by
// 240px). Mixing them would put per-page defects into a site-wide design
// language, which is how a broken page's markup ends up being copied as a
// convention.

const MOBILE = 'mobile';
const TABLET = 'tablet';
const DESKTOP = 'desktop';

// Finding ids. Kept as exported constants because agents/lib/design-consistency.js
// routes on them and a typo there would silently drop a whole class of finding.
export const RESPONSIVE_FINDING_IDS = Object.freeze({
  HORIZONTAL_OVERFLOW: 'horizontal-overflow',
  TAP_TARGET_TOO_SMALL: 'tap-target-too-small',
  SECTION_DOES_NOT_STACK: 'section-does-not-stack',
  CONTENT_CLIPPED: 'content-clipped',
});

// Overflow under this is noise: sub-pixel rounding, a 1px border, a scrollbar
// gutter. A real horizontal-scroll defect is visible, and visible means tens
// of pixels, not two.
const OVERFLOW_NOISE_PX = 8;

function median(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : Math.round((nums[mid - 1] + nums[mid]) / 2);
}

function viewportsIn(responsive) {
  return (responsive?.pages || []).flatMap((p) => Object.keys(p.byViewport || {}));
}

function measurementsAt(responsive, viewportName) {
  return (responsive?.pages || [])
    .map((p) => p.byViewport?.[viewportName])
    .filter(Boolean);
}

// ── Design Memory ──────────────────────────────────────────────────────────

/**
 * Site-level responsive facts, measured. Every field is null rather than a
 * default when nothing was measured — "we did not look" and "this site does
 * not do that" are different answers, and a generator that reads
 * `stacksAtMobile === false` would otherwise start laying content out in
 * columns on a site nobody ever probed.
 *
 * @param responsive capture.js's `responsive` block ({ viewports, pages }).
 */
export function summarizeResponsive(responsive) {
  const pages = responsive?.pages || [];
  if (!pages.length) return null;

  const measured = new Set(viewportsIn(responsive));
  const mobile = measurementsAt(responsive, MOBILE);
  const tablet = measurementsAt(responsive, TABLET);
  const desktop = measurementsAt(responsive, DESKTOP);

  // Does the site stack at mobile? Judged across every measured block on
  // every measured page: the share of multi-column blocks at desktop that
  // become single-column at mobile. A site that stacks will convert nearly
  // all of them; one that does not converts none.
  let stacksAtMobile = null;
  if (mobile.length && desktop.length) {
    let multiColumnAtDesktop = 0;
    let singleColumnAtMobile = 0;
    for (const page of pages) {
      const d = page.byViewport?.[DESKTOP];
      const m = page.byViewport?.[MOBILE];
      if (!d || !m) continue;
      const mobileByOrder = new Map((m.blocks || []).map((b) => [b.order, b]));
      for (const block of d.blocks || []) {
        if ((block.columns || 0) < 2) continue;
        multiColumnAtDesktop++;
        const counterpart = mobileByOrder.get(block.order);
        if (counterpart && (counterpart.columns || 0) <= 1) singleColumnAtMobile++;
      }
    }
    stacksAtMobile = multiColumnAtDesktop > 0
      ? singleColumnAtMobile / multiColumnAtDesktop >= 0.6
      : null; // nothing was in columns at desktop — stacking is not a concept here
  }

  // Does the nav collapse behind a control at mobile? True when a visible
  // toggle appears AND the visible link count actually drops — either alone
  // is ambiguous (a toggle can exist at every width; links can be hidden for
  // an unrelated reason).
  let navCollapsesAtMobile = null;
  if (mobile.length && desktop.length) {
    const desktopLinks = median(desktop.map((m) => m.navigation?.visibleLinks));
    const mobileLinks = median(mobile.map((m) => m.navigation?.visibleLinks));
    const mobileToggle = mobile.some((m) => m.navigation?.hasVisibleToggle);
    navCollapsesAtMobile = desktopLinks === null || mobileLinks === null
      ? null
      : mobileToggle && mobileLinks < desktopLinks;
  }

  const typeScaleFor = (set) => {
    const heading = median(set.map((m) => m.typography?.heading?.fontSize));
    const body = median(set.map((m) => m.typography?.body?.fontSize));
    return heading === null && body === null ? null : { heading, body };
  };
  const paddingFor = (set) => median(set.flatMap((m) => (m.blocks || []).map((b) => b.paddingTop)));

  const overflowFor = (set) => (set.length
    ? { pagesAffected: set.filter((m) => m.overflowPx > OVERFLOW_NOISE_PX).length, pagesMeasured: set.length }
    : null);

  return {
    measuredAt: new Date().toISOString(),
    viewports: (responsive.viewports || []).map((v) => ({ name: v.name, width: v.width, height: v.height })),
    pagesMeasured: pages.length,
    stacksAtMobile,
    navCollapsesAtMobile,
    typeScale: {
      desktop: measured.has(DESKTOP) ? typeScaleFor(desktop) : null,
      tablet: measured.has(TABLET) ? typeScaleFor(tablet) : null,
      mobile: measured.has(MOBILE) ? typeScaleFor(mobile) : null,
    },
    sectionPadding: {
      desktop: measured.has(DESKTOP) ? paddingFor(desktop) : null,
      tablet: measured.has(TABLET) ? paddingFor(tablet) : null,
      mobile: measured.has(MOBILE) ? paddingFor(mobile) : null,
    },
    horizontalOverflow: { tablet: overflowFor(tablet), mobile: overflowFor(mobile) },
  };
}

// ── Findings ───────────────────────────────────────────────────────────────

// Only the small viewports are checked for defects. Horizontal overflow at
// 1440px is a legitimate design choice (a full-bleed carousel); at 390px it
// is a page the visitor has to pan sideways to read.
const DEFECT_VIEWPORTS = [TABLET, MOBILE];

/**
 * Real, measured responsive defects — one finding per (page, viewport,
 * defect), in the same shape consistency-check.js's findings use so
 * design-consistency.js can persist both through one path.
 *
 * Every finding carries the numbers it was raised from. None of them carries
 * a proposed replacement class: there is no known-correct value for "what
 * should this section's layout classes be", and inventing one is exactly what
 * this pipeline refuses to do everywhere else. They are therefore real,
 * evidenced, human-reviewable findings rather than auto-appliable fixes —
 * see design-consistency.js for how that distinction is enforced.
 */
export function detectResponsiveIssues(responsive) {
  const findings = [];

  for (const page of responsive?.pages || []) {
    for (const viewportName of DEFECT_VIEWPORTS) {
      const m = page.byViewport?.[viewportName];
      if (!m) continue;

      // 1. HORIZONTAL OVERFLOW — the page is wider than the screen.
      if (m.overflowPx > OVERFLOW_NOISE_PX) {
        findings.push({
          id: RESPONSIVE_FINDING_IDS.HORIZONTAL_OVERFLOW,
          pageUrl: page.url,
          pageType: page.pageType,
          sectionRole: 'page',
          sectionOrder: null,
          evidence: {
            viewport: viewportName,
            viewportWidth: m.viewportWidth,
            documentScrollWidth: m.documentScrollWidth,
            overflowPx: m.overflowPx,
            offendingElements: (m.overflowingElements || []).map((el) => ({
              tag: el.tag, classes: el.classes, width: el.width, overflowBy: el.overflowBy,
            })),
            outerHtml: m.overflowingElements?.[0]?.outerHtml || '',
          },
        });
      }

      // 2. TAP TARGETS — controls below the WCAG 2.2 AA minimum.
      if (viewportName === MOBILE && (m.smallTapTargets || []).length) {
        findings.push({
          id: RESPONSIVE_FINDING_IDS.TAP_TARGET_TOO_SMALL,
          pageUrl: page.url,
          pageType: page.pageType,
          sectionRole: 'page',
          sectionOrder: null,
          evidence: {
            viewport: viewportName,
            count: m.smallTapTargets.length,
            minimumPx: 24,
            targets: m.smallTapTargets.map((el) => ({
              tag: el.tag, classes: el.classes, text: el.text, minSide: el.minSide,
            })),
            outerHtml: m.smallTapTargets[0]?.outerHtml || '',
          },
        });
      }

      // 3. DOES NOT STACK — a block still rendering in columns at mobile
      // width. Compared against the SAME block at desktop so a component
      // that was always one column is never reported.
      if (viewportName === MOBILE) {
        const desktopBlocks = new Map(((page.byViewport?.[DESKTOP]?.blocks) || []).map((b) => [b.order, b]));
        for (const block of m.blocks || []) {
          const desktopBlock = desktopBlocks.get(block.order);
          if (!desktopBlock) continue;
          if ((block.columns || 0) >= 2 && (desktopBlock.columns || 0) >= 2) {
            findings.push({
              id: RESPONSIVE_FINDING_IDS.SECTION_DOES_NOT_STACK,
              pageUrl: page.url,
              pageType: page.pageType,
              sectionRole: 'section',
              sectionOrder: block.order,
              evidence: {
                viewport: viewportName,
                viewportWidth: m.viewportWidth,
                columnsAtMobile: block.columns,
                columnsAtDesktop: desktopBlock.columns,
                sectionClasses: block.classes,
                outerHtml: block.outerHtml || '',
              },
            });
          }
        }
      }

      // 4. CLIPPED CONTENT — content cut off rather than wrapped.
      for (const el of m.clippedElements || []) {
        findings.push({
          id: RESPONSIVE_FINDING_IDS.CONTENT_CLIPPED,
          pageUrl: page.url,
          pageType: page.pageType,
          sectionRole: 'section',
          sectionOrder: null,
          evidence: {
            viewport: viewportName,
            tag: el.tag,
            sectionClasses: el.classes,
            clippedBy: el.clippedBy,
            outerHtml: el.outerHtml || '',
          },
        });
      }
    }
  }

  return findings;
}
