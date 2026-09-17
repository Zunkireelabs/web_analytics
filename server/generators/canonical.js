import { getSiteById } from '../store/read.js';
import { ownDomains, hostnameOf } from '../agents/lib/site-domain.js';
import { analyzePageUrl } from '../agents/lib/page-content.js';
import { textSimilarity } from '../agents/lib/duplicate-evidence.js';

// Pure, deterministic generator — no LLM call. A canonical tag's correct
// value is normally simply the page's own real, normalized URL (a self-
// referential canonical, the common fix for "no canonical tag").
//
// `params.canonicalTarget` is the one deliberate exception: pointing a
// page's canonical at a DIFFERENT real page on the same site — an
// editorial/duplicate-content decision this generator itself still has no
// judgment for, so it only ever accepts a target that's already been
// decided by real, multi-signal evidence upstream (agents/url-variant-
// duplicates.js's confidence-gated consolidation: one URL variant has
// (near-)ALL the real GSC clicks/impressions across a 90-day window and
// every other variant has none, so which one is the "same resource,
// different address" winner is a real, evidenced fact, not a guess). This
// generator's own job is still just re-verifying that evidence hasn't gone
// stale by the time it actually drafts — never re-deciding the winner
// itself.
//
// The implementer (server/implementers/backend.js) splices this into the
// page's own template via the head-scoped marker mechanism
// (server/implementers/lib/marker-merge.js's HEAD_SCOPED_FIELDS) — same
// code path regardless of self-referential or cross-page target.

export const meta = {
  id: 'canonical',
  name: 'Canonical Tag Generator',
  description: 'Drafts a rel="canonical" link for a page — self-referential by default, or pointing at a different same-site URL when a params.canonicalTarget has already been established by real evidence.',
  recommendationTags: [],
};

// params: { page: string, canonicalTarget?: string }
export async function generate({ siteId, params }) {
  const { page, canonicalTarget } = params || {};
  if (!page) throw Object.assign(new Error('page is required'), { status: 400 });

  let url;
  try { url = new URL(page); } catch { throw Object.assign(new Error(`"${page}" is not a valid URL`), { status: 400 }); }

  // Only asserted when the site has a real, human-confirmed domain to check
  // against — an unset website_domain passes through unfiltered rather than
  // blocking on an unresolved guess, same convention as filterOwnDomainPages.
  const site = await getSiteById(siteId);
  const domains = ownDomains(site);
  if (domains && !domains.includes(hostnameOf(page))) {
    throw Object.assign(new Error(`"${page}" is not on this site's own domain (${domains.join(', ')}) — refusing to draft a canonical tag for a page we can't confirm is real.`), { status: 400 });
  }

  let targetUrl = url;
  if (canonicalTarget) {
    try { targetUrl = new URL(canonicalTarget); } catch { throw Object.assign(new Error(`"${canonicalTarget}" is not a valid URL`), { status: 400 }); }
    if (domains && !domains.includes(hostnameOf(canonicalTarget))) {
      throw Object.assign(new Error(`canonicalTarget "${canonicalTarget}" is not on this site's own domain — refusing to point a canonical at a page we can't confirm is real.`), { status: 400 });
    }
    if (targetUrl.href === url.href) {
      throw Object.assign(new Error('canonicalTarget is the same URL as page — nothing to consolidate.'), { status: 400 });
    }
    // The evidence this was drafted from (the target has (near-)all the
    // real traffic, the source has none) is only ever computed from a PAST
    // run. Re-verify the target still resolves before pointing anything at
    // it — a target that's gone dead since detection would silently
    // canonicalize a real page to a broken one.
    const targetFetch = await analyzePageUrl(canonicalTarget);
    if (!targetFetch.ok) {
      throw Object.assign(
        new Error(`canonicalTarget "${canonicalTarget}" could not be confirmed live (${targetFetch.error || 'fetch failed'}) — refusing to consolidate onto a page that may no longer exist.`),
        { status: 400, userFacing: true, refusal: true, stale: true },
      );
    }
  }

  // The recommendation that led here is only ever generated from a PAST
  // audit fetch — this page's live state can have changed since (a
  // shared-layout fix that started self-referentially emitting
  // <link rel="canonical"> for every page, a manual template fix, a human
  // already resolving the duplicate some other way, ...). Re-checking live
  // rather than trusting the finding avoids drafting a fix for a gap
  // that's already closed. Same "stale: true" pattern as schema.js's own
  // already-fixed refusal — auto-remediation.js closes the recommendation
  // on sight instead of leaving it open to be re-attempted and re-refused
  // forever.
  const fetched = await analyzePageUrl(page);
  if (fetched.ok && fetched.analysis.hasCanonical) {
    const existingCanonical = fetched.analysis.canonicalUrl;
    // A page that already canonicalizes to the SAME target this draft
    // would set is not stale — it's already fixed by a prior run/human,
    // and re-drafting an identical value is a no-op worth refusing quietly
    // rather than noisily.
    if (existingCanonical && stripSlash(existingCanonical) === stripSlash(targetUrl.href)) {
      throw Object.assign(
        new Error(`"${page}" already has a canonical tag — drafting another would duplicate it, not fix a gap.`),
        { status: 400, userFacing: true, refusal: true, stale: true },
      );
    }
    // A canonical that just self-references the page itself is the shared
    // layout's own default (every page gets one, whether it's a real
    // canonical URL or a duplicate variant) — not a deliberate editorial
    // decision, so it's safe to override once real, evidenced upstream
    // consolidation evidence (canonicalTarget) says this page is actually a
    // duplicate of something else. Anything OTHER than self-reference is a
    // real prior decision (a human edit, another agent's own
    // consolidation, ...) this generator still has no basis to overwrite.
    const isDefaultSelfReference = existingCanonical && stripSlash(existingCanonical) === stripSlash(url.href);
    if (!canonicalTarget || !isDefaultSelfReference) {
      throw Object.assign(
        new Error(`"${page}" already has a canonical tag pointing elsewhere (${existingCanonical}) — a different decision is already live, refusing to overwrite it without a human call.`),
        { status: 400, userFacing: true, refusal: true, stale: true },
      );
    }
    // Falls through: existing canonical is just the page's own default
    // self-reference, and a validated canonicalTarget says this page is
    // really a duplicate of another URL — draft the override below.
  }

  return {
    content: { page, canonicalUrl: targetUrl.href },
    summary: canonicalTarget ? `Canonical → ${targetUrl.href} (consolidating a duplicate URL variant)` : `Canonical → ${targetUrl.href}`,
  };
}

const stripSlash = (u) => String(u || '').replace(/\/$/, '');

// Side-effect-free re-verification (server/generators/lib/verification-layer.js).
// Two things this checks that generate()'s own refusals don't distinguish:
//
// 1. already_resolved vs conflict on an existing canonical tag — generate()
//    refuses BOTH "already set to exactly what we'd draft" and "some
//    DIFFERENT canonical already exists" identically (a stale 400). The
//    first is genuinely nothing left to do; the second means a different
//    real decision (a human edit, a prior shipped fix, another agent's own
//    consolidation) is already live and disagrees with this recommendation
//    — worth recording as a conflict, not silently treated the same as "no
//    gap here."
//
// 2. Multi-agent disagreement on canonicalTarget — recommendation-
//    coordinator.js's dedup key has no discriminator for 'canonical' beyond
//    the losing page (see DEDUP_IDENTITY), so when more than one of
//    duplicate-content.js/url-variant-duplicates.js/query-param-
//    duplicates.js/templated-duplicates.js independently nominates the SAME
//    page, a later agent's canonicalTarget silently overwrites an earlier
//    one's with no record a disagreement happened — recommendations.params
//    is a wholesale overwrite (store/recommendations.js), not a merge.
//    `rec.detecting_agents` still correctly lists every agent that found
//    it, even though only one's target survived in params — that length is
//    the one honest signal left that this MAY be exactly that case.
//
//    This generator has no access to whichever OTHER target(s) were
//    proposed and discarded — that evidence never reached here — so it
//    cannot re-derive who the "real" winner is. What it CAN safely re-check
//    is whether the surviving stored target still looks like the same real
//    duplicate-content pair the evidence originally described: the same
//    content-similarity signal (Jaccard word overlap) and the same 0.7 bar
//    duplicate-evidence.js's own split-traffic escalation uses for
//    "genuinely the same content." Below that bar with more than one
//    detecting agent on record, the stored decision can no longer be
//    trusted at face value AND at least one other agent's disagreement is
//    already known to have been silently discarded — genuinely needs a
//    human, not a guess. At or above the bar, multiple independent
//    detectors corroborating the same real duplicate is, if anything,
//    stronger evidence than the single-agent case, not weaker.
export async function verifyCurrentState(rec, { site } = {}) {
  const page = rec.params?.page || rec.page;
  const canonicalTarget = rec.params?.canonicalTarget || null;
  if (!page) return { decision: 'still_valid', reason: 'missing-params', evidence: null };

  const fetched = await analyzePageUrl(page);
  if (!fetched.ok) return { decision: 'still_valid', reason: 'unreachable', evidence: { page, error: fetched.error } };

  const { hasCanonical, canonicalUrl } = fetched.analysis;
  if (hasCanonical) {
    const intendedTarget = canonicalTarget || page;
    if (canonicalUrl && stripSlash(canonicalUrl) === stripSlash(intendedTarget)) {
      return { decision: 'already_resolved', reason: 'canonical-already-set-to-target', evidence: { page, canonicalUrl } };
    }
    // Same distinction generate()'s own override check makes: a canonical
    // that just self-references the page is the shared layout's default,
    // not a real prior decision — still fixable, not a conflict, as long as
    // a real canonicalTarget exists to override it with. Only a canonical
    // pointing somewhere else entirely (neither the target nor the page
    // itself) reflects an actual decision this generator has no basis to
    // overwrite.
    const isDefaultSelfReference = canonicalUrl && stripSlash(canonicalUrl) === stripSlash(page);
    if (canonicalTarget && isDefaultSelfReference) {
      return { decision: 'still_valid', reason: 'default-self-canonical-overridable', evidence: { page, canonicalUrl, canonicalTarget } };
    }
    return {
      decision: 'conflict', reason: 'different-canonical-already-present',
      evidence: { page, liveCanonicalUrl: canonicalUrl, recommendedTarget: intendedTarget },
    };
  }

  if (!canonicalTarget) {
    return { decision: 'still_valid', reason: 'no-canonical-present', evidence: { page } };
  }

  const targetFetch = await analyzePageUrl(canonicalTarget);
  if (!targetFetch.ok) {
    return { decision: 'still_valid', reason: 'target-unreachable', evidence: { page, canonicalTarget, error: targetFetch.error } };
  }

  if (rec.detecting_agents?.length > 1) {
    const similarity = textSimilarity(fetched.analysis.bodyText, targetFetch.analysis.bodyText);
    if (similarity < 0.7) {
      return {
        decision: 'conflict', reason: 'stored-target-no-longer-matches-content',
        evidence: { page, canonicalTarget, similarity, detectingAgents: rec.detecting_agents },
      };
    }
  }

  return { decision: 'still_valid', reason: 'fixable-now', evidence: { page, canonicalTarget } };
}
