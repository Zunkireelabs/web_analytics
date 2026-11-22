import { getSiteById } from '../store/read.js';
import { ownDomains, hostnameOf } from '../agents/lib/site-domain.js';
import { analyzePageUrl } from '../agents/lib/page-content.js';
import { isSharedTemplateFile, resolveAdapter, resolveFile } from '../implementers/lib/url-file-map.js';
import { supportsTemplateBreadcrumbs } from '../implementers/lib/template-breadcrumbs.js';
import { resolvePageMove } from '../lib/redirect-resolution.js';

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
const siteNameOf = (site, url) => site?.name || url.hostname;
// "Page title | Site name" -> "Page title". Kept only when it is a sensible length; otherwise the caller falls back to the slug.
export function cleanTitle(title, siteName) {
  let t = String(title || '').replace(/&amp;/g, '&').trim();
  if (!t) return null;
  const parts = t.split(/\s+[|\u2013\u2014-]\s+/).map((x) => x.trim()).filter(Boolean);
  if (parts.length > 1) {
    const name = String(siteName || '').toLowerCase();
    const kept = parts.filter((p) => !name || !p.toLowerCase().includes(name.split(' ')[0]));
    t = (kept.length ? kept : parts)[0];
  }
  return t.length >= 2 && t.length <= 90 ? t : null;
}

export async function generate({ siteId, params }, deps = {}) {
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

  // A page whose file is a template shared by many URLs cannot take a static, page-specific trail: it would appear on every page that
  // uses the template. For a template of a supported stack (Next.js app router, Astro dynamic page, Eleventy/Nunjucks) the draft is instead ONE edit to the template that builds the trail from the
  // page's own address and heading (implementers/lib/template-breadcrumbs.js), so every page using it is covered at once. Any
  // other kind of shared template needs a person: parked once with the reason, never a wrong trail written everywhere.
  const shared = site && !resolveAdapter(site, page, 'breadcrumbs') && isSharedTemplateFile(site, page);
  let templateFile = null;
  if (shared) {
    templateFile = resolveFile(site, page);
    if (!supportsTemplateBreadcrumbs(templateFile)) {
      throw Object.assign(
        new Error('This page is built from a template shared by many pages, so one fixed breadcrumb trail would appear on all of them. It needs a template change that builds the trail from each page\'s own name and URL.'),
        { status: 400, userFacing: true, needsInput: true, reason: 'needs-input:shared-template-breadcrumbs' },
      );
    }
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

  if (templateFile) {
    return {
      content: { page, templateEdit: { file: templateFile, origin: url.origin, pagePath: url.pathname } },
      summary: `Breadcrumbs for every page built from ${templateFile} (one template edit; each page's trail is built from its own address and heading)`,
    };
  }

  // Only REAL pages go in the trail: an ancestor that is a 404 (for example /category when only /category/<name> exists) is skipped,
  // so the markup never points a search engine at a page that is not there. The last crumb is the page's own title when it can be read
  // (the slug is only the fallback); the first is "Home".
  const liveStatus = deps.liveStatus || (async (u) => { const r = await resolvePageMove(u).catch(() => null); return r?.ok && !r.moved && r.status === 200; });
  const ownTitle = fetched.ok ? cleanTitle(fetched.analysis.title, siteNameOf(site, url)) : null;
  const itemListElement = [{ '@type': 'ListItem', position: 1, name: 'Home', item: `${url.origin}/` }];
  let pathSoFar = '';
  for (let i = 0; i < segments.length; i++) {
    pathSoFar += `/${segments[i]}`;
    const isLast = i === segments.length - 1;
    const item = `${url.origin}${pathSoFar}`;
    // eslint-disable-next-line no-await-in-loop
    if (!isLast && !(await liveStatus(item))) continue;
    itemListElement.push({ '@type': 'ListItem', position: itemListElement.length + 1, name: isLast ? (ownTitle || titleCaseSlug(segments[i])) : titleCaseSlug(segments[i]), item });
  }

  const jsonLd = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement };
  return {
    content: { page, jsonLd },
    summary: `Breadcrumbs (${itemListElement.length} levels) for ${page}`,
  };
}

// Is the trail already there? Re-reads the LIVE page (following redirects). A BreadcrumbList that is already on the page is the outcome this
// generator exists to produce, so there is nothing left to draft. A fetch failure says nothing about the page and never closes anything.
export async function verifyCurrentState(rec) {
  const page = rec.params?.page || rec.page;
  if (!page) return { decision: 'still_valid', reason: 'missing-params', evidence: null };
  const fetched = await analyzePageUrl(page);
  if (!fetched.ok) return { decision: 'still_valid', reason: 'unreachable', evidence: { page, error: fetched.error } };
  const { schemaTypes = [], isRootPage } = fetched.analysis;
  if (schemaTypes.includes('BreadcrumbList')) return { decision: 'already_resolved', reason: 'breadcrumb-list-already-present', evidence: { page, schemaTypes } };
  if (isRootPage) return { decision: 'already_resolved', reason: 'homepage-needs-no-trail', evidence: { page } };
  return { decision: 'still_valid', reason: 'breadcrumb-list-absent', evidence: { page, schemaTypes } };
}
