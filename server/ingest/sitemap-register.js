import { listSitemaps, submitSitemap } from './gsc-technical.js';
import { fetchTextIfExists } from '../agents/lib/page-content.js';
import { siteOriginFor } from '../agents/lib/site-domain.js';

// First-connect step: make sure the site's own Search Console property has a sitemap registered.
//
// Everything downstream reads the sitemap list Search Console holds for the property: site discovery
// (agents/lib/site-discovery.js), the sitemap agent and the post-merge resubmit (notifyOfPageChange). A
// project that has never had a sitemap registered finds no pages at all, so connecting Search Console
// has to do this, not wait for someone to do it by hand.
//
// The path is never guessed. We take what the site itself says (a `Sitemap:` line in robots.txt) or the
// conventional /sitemap.xml and /sitemap_index.xml, and only when the file is really there and really is a
// sitemap (fetchTextIfExists refuses an HTML catch-all page). Best-effort: the result says what happened and
// the caller never fails because of it.

const CONVENTIONAL = ['/sitemap.xml', '/sitemap_index.xml'];
const looksLikeSitemap = (text) => /<(urlset|sitemapindex)[\s>]/i.test(text || '');

// A URL-prefix property ("https://example.com/") only accepts sitemaps under that prefix; a domain property
// ("sc-domain:example.com") accepts any URL on the domain.
export function sitemapFitsProperty(sitemapUrl, gscProperty) {
  let sitemap;
  try { sitemap = new URL(sitemapUrl); } catch { return false; }
  if (!/^https?:$/.test(sitemap.protocol)) return false;
  if (gscProperty.startsWith('sc-domain:')) {
    const domain = gscProperty.slice('sc-domain:'.length).toLowerCase();
    const host = sitemap.hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  }
  return sitemap.href.startsWith(gscProperty);
}

export async function findSitemapUrl(site, { fetchText = fetchTextIfExists } = {}) {
  const origin = siteOriginFor(site);
  if (!origin) return { found: false, reason: 'no-domain' };

  const robots = await fetchText(`${origin}/robots.txt`);
  const declared = robots.ok
    ? [...robots.text.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1].trim())
    : [];
  for (const url of [...declared, ...CONVENTIONAL.map((p) => origin + p)]) {
    if (!sitemapFitsProperty(url, site.gsc_property)) continue;
    const res = await fetchText(url);
    if (res.ok && looksLikeSitemap(res.text)) return { found: true, url };
  }
  return { found: false, reason: 'no-sitemap-found' };
}

// -> { status: 'submitted' | 'already-registered' | 'skipped' | 'failed', ... }
export async function ensureSitemapRegistered(site, { list = listSitemaps, submit = submitSitemap, fetchText } = {}) {
  if (!site?.gsc_property) return { status: 'skipped', reason: 'no-gsc-property' };

  const existing = await list(site);
  if (!existing.ok) return { status: 'failed', reason: 'sitemap-list-failed', error: existing.error };
  if (existing.sitemaps.length) return { status: 'already-registered', sitemaps: existing.sitemaps.map((s) => s.path) };

  const found = await findSitemapUrl(site, { fetchText });
  if (!found.found) return { status: 'skipped', reason: found.reason };

  const sent = await submit(site, found.url);
  if (!sent.ok) return { status: 'failed', reason: sent.reason, error: sent.error, sitemap: found.url };
  return { status: 'submitted', sitemap: found.url };
}
