import * as cheerio from 'cheerio';

// What a related-guides card needs to know about the page it links to: its real title, description and image, read from that page's own tags.
// Nothing is invented: a lookup that fails, or a page that has no such tag, simply leaves that part out of the card.
// The fetch is injectable (and the production default goes through the free audit's SSRF-guarded fetcher, never a bare fetch of a model-supplied URL).

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

export function parseTargetMeta(html, pageUrl) {
  const $ = cheerio.load(html || '');
  const meta = (sel) => clean($(sel).attr('content'));
  let title = meta('meta[property="og:title"]') || clean($('title').first().text());
  title = title.replace(/\s*[|–—-]\s*[^|–—-]{1,40}$/, '').trim() || title; // drop a trailing " | Site name"
  const description = meta('meta[property="og:description"]') || meta('meta[name="description"]');
  let image = meta('meta[property="og:image"]');
  if (image) { try { image = new URL(image, pageUrl).href; } catch { image = ''; } }
  return { title: title || null, description: description || null, image: image || null };
}

async function guardedFetchHtml(url) {
  const { fetchMainPage, normalizeUrl } = await import('../../free-audit/fetchPage.js');
  const r = await fetchMainPage(normalizeUrl(url));
  return r.html ?? r.body ?? '';
}

/** Adds `meta` to each suggestion that has a resolvable target. Never throws: a failed lookup leaves that suggestion without meta. */
export async function enrichSuggestionsWithMeta(site, suggestions, { fetchHtml = guardedFetchHtml, origin = null } = {}) {
  const base = origin || (site?.website_domain ? (/^https?:\/\//i.test(site.website_domain) ? site.website_domain : `https://${site.website_domain}`) : null);
  return Promise.all((suggestions || []).map(async (s) => {
    if (!s?.targetUrl) return s;
    try {
      const abs = new URL(s.targetUrl, base || undefined).href;
      return { ...s, meta: parseTargetMeta(await fetchHtml(abs), abs) };
    } catch { return s; }
  }));
}
