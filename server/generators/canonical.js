import { getSiteById } from '../store/read.js';
import { ownDomains, hostnameOf } from '../agents/lib/site-domain.js';
import { analyzePageUrl } from '../agents/lib/page-content.js';

// Pure, deterministic generator — no LLM call. A canonical tag's correct
// value here is simply the page's own real, normalized URL (a self-
// referential canonical, the common fix for "no canonical tag" — this
// platform has no signal for picking a DIFFERENT page as canonical, which
// would be an editorial/duplicate-content decision, not a draftable fact).
// The implementer (server/implementers/backend.js) splices this into the
// page's own template via the head-scoped marker mechanism
// (server/implementers/lib/marker-merge.js's HEAD_SCOPED_FIELDS).

export const meta = {
  id: 'canonical',
  name: 'Canonical Tag Generator',
  description: 'Drafts a self-referential rel="canonical" link for a page.',
  recommendationTags: [],
};

// params: { page: string }
export async function generate({ siteId, params }) {
  const { page } = params || {};
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

  // The recommendation that led here (technical-seo.js's "no canonical tag"
  // finding) is only ever generated from a PAST audit fetch — this page's
  // live state can have changed since (a shared-layout fix that started
  // self-referentially emitting <link rel="canonical"> for every page, a
  // manual template fix, ...). Re-checking live rather than trusting the
  // finding avoids drafting (and getting permanently stuck on, if no
  // per-page marker was ever configured for a tag the page never actually
  // needed) a fix for a gap that's already closed. Same "stale: true"
  // pattern as schema.js's own already-fixed refusal — auto-remediation.js
  // closes the recommendation on sight instead of leaving it open to be
  // re-attempted and re-refused forever.
  const fetched = await analyzePageUrl(page);
  if (fetched.ok && fetched.analysis.hasCanonical) {
    throw Object.assign(
      new Error(`"${page}" already has a canonical tag — drafting another would duplicate it, not fix a gap.`),
      { status: 400, userFacing: true, refusal: true, stale: true },
    );
  }

  return {
    content: { page, canonicalUrl: url.href },
    summary: `Canonical → ${url.href}`,
  };
}
