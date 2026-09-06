import * as cheerio from 'cheerio';
import { fetchHtml, isPrivateOrLocalHost } from './page-content.js';
import { describeFetchFailure, describeHttpFailure } from '../../lib/errors.js';

// Visits a client's own website and picks out their logo, so onboarding
// doesn't require staff to manually source and upload a logo file.
// data:URIs land straight in sites.logo_data_url — same shape connect-site.js's
// manual --logo flag already produces, so Sidebar.jsx needs no changes.

const FETCH_TIMEOUT_MS = 5000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // logo_data_url is TEXT with no DB-side cap
// and is fetched on every dashboard page load — keep it small.

const LOGO_IMG_SELECTOR = 'img[class*="logo" i], img[id*="logo" i], img[alt*="logo" i]';

function firstCandidate($, baseUrl) {
  const headerImg = $('header, nav').find(LOGO_IMG_SELECTOR).first().attr('src');
  const resolvedHeaderImg = resolve(headerImg, baseUrl);
  if (resolvedHeaderImg) return { url: resolvedHeaderImg, source: 'img.logo (header)' };

  const anyImg = $(LOGO_IMG_SELECTOR).first().attr('src');
  const resolvedAnyImg = resolve(anyImg, baseUrl);
  if (resolvedAnyImg) return { url: resolvedAnyImg, source: 'img.logo' };

  const touchIcon = $('link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]').first().attr('href');
  const resolvedTouchIcon = resolve(touchIcon, baseUrl);
  if (resolvedTouchIcon) return { url: resolvedTouchIcon, source: 'apple-touch-icon' };

  const ogImage = $('meta[property="og:image"]').attr('content');
  const resolvedOgImage = resolve(ogImage, baseUrl);
  if (resolvedOgImage) return { url: resolvedOgImage, source: 'og:image' };

  const icon = $('link[rel="icon"], link[rel="shortcut icon"]').first().attr('href');
  const resolvedIcon = resolve(icon, baseUrl);
  if (resolvedIcon) return { url: resolvedIcon, source: 'favicon' };

  const defaultFavicon = resolve('/favicon.ico', baseUrl);
  return defaultFavicon ? { url: defaultFavicon, source: 'favicon (default path)' } : { url: null };
}

// Only http(s) URLs are fetchable image sources — some sites set
// `<link rel="icon" href="data:,">` to suppress the default favicon request,
// which is a valid URL but not something to download; treat it (and any
// other non-http(s) scheme) as "no candidate" so the chain above keeps
// looking instead of failing on it.
function resolve(href, baseUrl) {
  if (!href) return null;
  try {
    const resolved = new URL(href, baseUrl);
    return /^https?:$/.test(resolved.protocol) ? resolved.toString() : null;
  } catch { return null; }
}

async function fetchImage(url) {
  let hostname;
  try { hostname = new URL(url).hostname; } catch { return { ok: false, error: 'invalid image URL' }; }
  if (isPrivateOrLocalHost(hostname)) return { ok: false, error: 'blocked: private/local address' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZunkireeAnalyticsBot/1.0; +logo-discovery)' },
    });
    if (!res.ok) return { ok: false, error: describeHttpFailure(res.status) };
    const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!contentType.startsWith('image/')) return { ok: false, error: 'not an image' };
    const contentLength = Number(res.headers.get('content-length'));
    if (contentLength && contentLength > MAX_IMAGE_BYTES) return { ok: false, error: 'too large' };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) return { ok: false, error: 'too large' };
    return { ok: true, buf, contentType };
  } catch (err) {
    return { ok: false, error: describeFetchFailure('logo-discovery.fetchImage', err) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function discoverLogo(siteUrl) {
  const normalized = /^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`;

  const page = await fetchHtml(normalized);
  if (!page.ok) return { ok: false, error: `couldn't load site: ${page.error}` };

  const $ = cheerio.load(page.html);
  const candidate = firstCandidate($, normalized);
  if (!candidate.url) return { ok: false, error: 'no candidates found' };

  const image = await fetchImage(candidate.url);
  if (!image.ok) return { ok: false, error: image.error };

  return {
    ok: true,
    dataUrl: `data:${image.contentType};base64,${image.buf.toString('base64')}`,
    source: candidate.source,
    candidateUrl: candidate.url,
  };
}
