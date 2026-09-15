import { getSiteById } from '../store/read.js';
import { ownDomains, hostnameOf } from '../agents/lib/site-domain.js';
import { analyzePageUrl } from '../agents/lib/page-content.js';

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
    // A page that already canonicalizes to the SAME target this draft
    // would set is not stale — it's already fixed by a prior run/human,
    // and re-drafting an identical value is a no-op worth refusing quietly
    // rather than noisily. Only a DIFFERENT existing canonical is treated
    // as "someone already made a different call here."
    throw Object.assign(
      new Error(`"${page}" already has a canonical tag — drafting another would duplicate it, not fix a gap.`),
      { status: 400, userFacing: true, refusal: true, stale: true },
    );
  }

  return {
    content: { page, canonicalUrl: targetUrl.href },
    summary: canonicalTarget ? `Canonical → ${targetUrl.href} (consolidating a duplicate URL variant)` : `Canonical → ${targetUrl.href}`,
  };
}
