import { findOpenRecommendation, insertRecommendation } from '../../store/recommendations.js';
import { syncFromGrounded } from './recommendation-coordinator.js';
import { generateDraft } from '../../routes/action-center.js';
import { impactFromPriority } from './findings.js';

// Turns consistency-check.js's real, section-level findings into real
// Action Center recommendations.
//
// The architecture: the Design Agent is a DIAGNOSTICIAN, not the only
// implementer. A finding whose evidence already carries an exact, real,
// already-observed replacement value (this site's own convention, never
// invented) is deterministically fixable the same way every other
// generator in this app fixes things — by patching a live-captured anchor,
// refusing rather than guessing when the anchor no longer matches. Only a
// finding with no such exact target is genuinely manual.
//
// TABLE_FINDING and TYPOGRAPHY_FINDING both carry `evidence.siteConvention`
// — the real class string profile-extract.js already observed elsewhere on
// THIS site — and, since consistency-check.js was extended alongside this
// file, `evidence.outerHtml` — the live-captured anchor
// content-integrity-repair.js's 'table-style-drift'/'typography-drift'
// fixTypes patch against (see that generator for the actual class swap,
// and content-integrity-inject.js for the byte-for-byte anchor-match
// safety net every fixType in this app already goes through). Routed via
// syncFromGrounded — the same path every other generator-backed finding in
// this codebase uses — so dedup, block-state refresh, and stale-closure all
// work identically to any other recommendation, not a second bespoke
// lifecycle.
//
// RESPONSIVE_FINDING carries no such target — only the site's real
// breakpoint prefixes (e.g. ["sm:","md:"]), never WHICH breakpoint classes
// with WHAT values a fixed section should carry. Inventing that would be
// exactly the "here is the correct markup" synthesis consistency-check.js's
// own module comment says this whole scan deliberately never does. That
// finding — and a table/typography finding whose live anchor capture failed
// for any reason — stays manual, one bundled 'design-consistency-review'
// row per page (unchanged from before this file routed anything), so a
// human still gets ONE card per page to look at rather than N near-
// identical rows.
// MEASURED RESPONSIVE DEFECTS (responsive-analysis.js) arrive in this same
// findings list and are deliberately NOT in the routable set. The reason is
// the same one that keeps missing-responsive-classes out of it, and it is
// worth being explicit about because "make it automatic" is the obvious
// instinct here: a class-swap fix needs a known-correct replacement VALUE,
// and for "this section still renders in two columns at 390px" there is no
// such value anywhere on the site. The site's own conventions tell us which
// breakpoint prefixes it uses, never which layout classes THIS section should
// carry — and copying another section's whole class attribute onto it would
// change its colors, spacing and type along with its layout. That is the
// invention this pipeline refuses to do everywhere else (see
// consistency-check.js's module comment and content-integrity-repair.js's
// refuse-rather-than-guess branches).
//
// So they become real, visible, evidence-carrying recommendations a human can
// act on — with the actual numbers (how many px it overflows by, how many
// columns it kept, which controls are under 24px) rather than a class-name
// hunch. They are never silently dropped, and never auto-applied.
const ROUTABLE_FINDING_IDS = new Set(['table-style-drift', 'typography-drift']);

function isRoutable(f) {
  return ROUTABLE_FINDING_IDS.has(f.id) && !!f.evidence?.outerHtml && !!f.evidence?.siteConvention;
}

// One line of real evidence per finding, for the human reading the card.
// JSON.stringify(evidence) was fine when every finding was two short class
// strings; a responsive finding carries a live outerHtml anchor (up to 4KB)
// that would bury the numbers that actually matter.
function describeFinding(f) {
  const e = f.evidence || {};
  switch (f.id) {
    case 'horizontal-overflow':
      return `the page is ${e.overflowPx}px wider than the ${e.viewportWidth}px ${e.viewport} viewport, so it scrolls sideways`
        + (e.offendingElements?.length
          ? ` — widest offender: <${e.offendingElements[0].tag}${e.offendingElements[0].classes ? ` class="${e.offendingElements[0].classes}"` : ''}> (${e.offendingElements[0].overflowBy}px over)`
          : '');
    case 'tap-target-too-small':
      return `${e.count} control(s) render smaller than the ${e.minimumPx}px minimum tap target at ${e.viewport}`
        + (e.targets?.length ? ` — e.g. "${e.targets[0].text || e.targets[0].tag}" at ${e.targets[0].minSide}px` : '');
    case 'section-does-not-stack':
      return `section ${f.sectionOrder} still renders ${e.columnsAtMobile} columns at ${e.viewportWidth}px (it is ${e.columnsAtDesktop} at desktop, so it never stacks)`
        + (e.sectionClasses ? ` — classes: "${e.sectionClasses}"` : '');
    case 'content-clipped':
      return `a <${e.tag}> is cut off by ${e.clippedBy}px at ${e.viewport} instead of wrapping`
        + (e.sectionClasses ? ` — classes: "${e.sectionClasses}"` : '');
    case 'missing-responsive-classes':
      return `this section carries none of the site's own breakpoint prefixes (${(e.siteBreakpoints || []).join(', ')}) — classes: "${e.sectionClasses}"`;
    default:
      return JSON.stringify(e);
  }
}

const RESPONSIVE_FINDING_IDS = new Set([
  'horizontal-overflow', 'tap-target-too-small', 'section-does-not-stack', 'content-clipped',
]);

// One grounded item per routable finding — content-integrity-repair's
// generate() only ever patches one anchor per draft, so one section's drift
// is one recommendation, exactly like its other fixTypes' one-defect-per-row
// shape. sectionOrder/textRole are threaded into params (not just used
// locally) because recommendationPageKey reads them straight off params to
// keep two drifted sections on the same page from colliding into one row.
function routedItemFor(f) {
  const fixType = f.id;
  const textRole = f.evidence.textRole || null;
  const findingId = `design-consistency:${fixType}:${f.pageUrl}:${f.sectionOrder}:${textRole || ''}`;
  const kind = fixType === 'table-style-drift' ? 'table' : `${textRole || 'text'} section`;
  return {
    id: findingId,
    generatorId: 'content-integrity-repair',
    tag: `A ${kind}'s styling drifts from this site's own design convention — ${f.pageUrl}`,
    reason: `A whole-page design-consistency scan found this exact ${kind}'s classes ("${f.evidence.sectionClasses}") share nothing with the site's own real, already-observed convention ("${f.evidence.siteConvention}") for this kind of element. content-integrity-repair can correct it deterministically — swapping only the class attribute against the live-captured anchor, refusing if the anchor has since changed — without inventing any new markup.`,
    params: {
      page: f.pageUrl, fixType,
      sectionClasses: f.evidence.sectionClasses, siteConvention: f.evidence.siteConvention,
      outerHtml: f.evidence.outerHtml, sectionOrder: f.sectionOrder, textRole,
    },
    source: 'design-consistency',
    priority: 'medium',
    expectedImpact: { label: impactFromPriority('medium'), basis: 'estimate', value: null },
    blockedReason: null,
  };
}

export async function persistConsistencyFindings(siteId, findings) {
  const byPage = new Map();
  for (const f of findings || []) {
    if (!byPage.has(f.pageUrl)) byPage.set(f.pageUrl, []);
    byPage.get(f.pageUrl).push(f);
  }

  let automatable = 0;
  let manualCreated = 0;
  let manualSkipped = 0;
  const routedItems = [];

  for (const [pageUrl, pageFindings] of byPage) {
    const routable = pageFindings.filter(isRoutable);
    const manual = pageFindings.filter((f) => !isRoutable(f));

    automatable += routable.length;
    for (const f of routable) routedItems.push(routedItemFor(f));

    if (!manual.length) continue;

    const findingId = `design-consistency:${pageUrl}`;
    const existing = await findOpenRecommendation(siteId, pageUrl, 'design-consistency-review');
    if (existing) { manualSkipped++; continue; }

    const byKind = {};
    for (const f of manual) byKind[f.id] = (byKind[f.id] || 0) + 1;
    const summary = Object.entries(byKind).map(([kind, n]) => `${n}× ${kind}`).join(', ');
    const detail = manual.slice(0, 8).map((f) =>
      `- [${f.sectionRole}] ${f.id}: ${describeFinding(f)}`
    ).join('\n');

    const responsiveCount = manual.filter((f) => RESPONSIVE_FINDING_IDS.has(f.id)).length;

    await insertRecommendation(siteId, {
      page: pageUrl,
      recommendationType: 'design-consistency-review',
      issue: responsiveCount
        ? `${manual.length} design issue(s) on this page, including ${responsiveCount} measured at tablet/mobile width (${summary})`
        : `${manual.length} section(s) on this page don't match the site's own real design conventions (${summary})`,
      reason: `A whole-page design scan found real, evidenced problems. Class drift is compared against this site's own stored design profile, never invented; responsive defects are MEASURED in a real browser at 834px (tablet) and 390px (mobile) — rendered geometry, not class-name guesswork.\n\nNo generator can safely fix these automatically: there is no known-correct replacement value for "what should this section's layout classes be", and copying another section's classes would change its color, spacing and type along with its layout. So this needs a human look.\n\n${detail}`,
      params: { page: pageUrl, findings: manual },
      findingId,
      detectingAgent: 'design-consistency',
      priority: manual.length >= 3 ? 'high' : 'medium',
      riskTier: 'manual',
      expectedImpact: { label: impactFromPriority(manual.length >= 3 ? 'high' : 'medium'), basis: 'estimate', value: null },
    });
    manualCreated++;
  }

  if (routedItems.length) {
    await syncFromGrounded(siteId, { items: routedItems });

    // Give the Design Agent a REAL, distinctly-labeled producer entry into
    // the shared autonomous queue — mirroring analyst-seo-mapping.js's
    // qualifyAndShipContentGaps, the established pattern for "this detecting
    // agent gets its own countable lane": call generateDraft directly, right
    // here, with source: 'design-agent' (see AUTONOMOUS_DRAFT_SOURCES in
    // lib/autonomous-quota.js). generateDraft is idempotent per findingId, so
    // this never double-generates across repeat weekly scans, and the daily
    // auto-remediation pass's own shipDraftForRecommendation call later just
    // reuses this same draft (and its source) rather than recreating it — the
    // recommendation inserted by syncFromGrounded above is what makes that
    // pass pick it up at all; this is what makes the resulting draft
    // countable as Design Agent's own spend instead of folding silently into
    // generic 'auto-remediation' accounting. Best-effort and fails open: a
    // generation failure here just leaves the finding as an ungenerated
    // recommendation for the normal daily pass to draft later, exactly as it
    // did before this existed.
    for (const item of routedItems) {
      try {
        await generateDraft(siteId, {
          generatorId: item.generatorId, params: item.params, source: 'design-agent', findingId: item.id,
        });
      } catch (err) {
        console.error(`[design-consistency] site ${siteId} could not pre-draft "${item.id}":`, err.message);
      }
    }
  }

  return {
    totalFindings: findings?.length || 0,
    automatable,
    manualCreated,
    manualSkipped,
    pagesWithFindings: byPage.size,
  };
}
