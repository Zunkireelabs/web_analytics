import { getSiteById } from '../store/read.js';
import { ownDomains, hostnameOf } from '../agents/lib/site-domain.js';
import { analyzePageUrl } from '../agents/lib/page-content.js';

// Pure, deterministic generator — no LLM call, same shape as canonical.js.
// A BreadcrumbList's correct value here is simply the page's own real URL
// path, segment by segment — there is no fact to fabricate: every listed
// crumb's name is derived from the real path segment, and its url is the
// real resolved ancestor URL. The implementer (marker-merge.js's HEAD-
// scoped JSON-LD field) publishes it the same way schema.js's output does.

export const meta = {
  id: 'breadcrumbs',
  name: 'Breadcrumbs Schema Generator',
  description: 'Drafts a BreadcrumbList JSON-LD trail derived from the page\'s real URL path.',
  recommendationTags: ['Missing breadcrumbs'],
};

function titleCaseSlug(slug) {
  return decodeURIComponent(slug)
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

// params: { page: string }
export async function generate({ siteId, params }) {
  const { page } = params || {};
  if (!page) throw Object.assign(new Error('page is required'), { status: 400 });

  let url;
  try { url = new URL(page); } catch { throw Object.assign(new Error(`"${page}" is not a valid URL`), { status: 400 }); }

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length === 0) {
    throw Object.assign(new Error('This page is the site root — there is no real breadcrumb trail to draft.'), { status: 400, userFacing: true });
  }

  const site = await getSiteById(siteId);
  const domains = ownDomains(site);
  if (domains && !domains.includes(hostnameOf(page))) {
    throw Object.assign(new Error(`"${page}" is not on this site's own domain (${domains.join(', ')}) — refusing to draft breadcrumbs for a page we can't confirm is real.`), { status: 400 });
  }

  // The page already carries a real BreadcrumbList — drafting another would
  // produce a second, duplicate JSON-LD block rather than filling a real
  // gap. Same "re-check live rather than trust the caller" reasoning as
  // schema.js's own existing-schema-type refusal: this generator can be
  // triggered manually or against stale recommendation state, not only from
  // a fresh "Missing breadcrumbs" finding.
  const fetched = await analyzePageUrl(page);
  if (fetched.ok && fetched.analysis.schemaTypes.includes('BreadcrumbList')) {
    throw Object.assign(
      new Error('This page already has real BreadcrumbList schema — drafting another would duplicate it, not fix a gap.'),
      { status: 400, userFacing: true },
    );
  }

  const siteName = site?.name || url.hostname;
  const itemListElement = [{ '@type': 'ListItem', position: 1, name: siteName, item: `${url.origin}/` }];
  let pathSoFar = '';
  segments.forEach((seg, i) => {
    pathSoFar += `/${seg}`;
    itemListElement.push({
      '@type': 'ListItem', position: i + 2, name: titleCaseSlug(seg), item: `${url.origin}${pathSoFar}`,
    });
  });

  const jsonLd = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement };
  return {
    content: { page, jsonLd },
    summary: `Breadcrumbs (${itemListElement.length} levels) for ${page}`,
  };
}
