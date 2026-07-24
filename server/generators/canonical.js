import { getSiteById } from '../store/read.js';
import { knownDomain, hostnameOf } from '../agents/lib/site-domain.js';

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
  const domain = knownDomain(site);
  if (domain && hostnameOf(page) !== domain) {
    throw Object.assign(new Error(`"${page}" is not on this site's own domain (${domain}) — refusing to draft a canonical tag for a page we can't confirm is real.`), { status: 400 });
  }

  return {
    content: { page, canonicalUrl: url.href },
    summary: `Canonical → ${url.href}`,
  };
}
