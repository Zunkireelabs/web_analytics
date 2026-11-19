import * as cheerio from 'cheerio';
import { fetchHtml } from './page-content.js';
import { discoverLogo } from './logo-discovery.js';
import { normalizeHex, usable } from '../../report/brand.js';

// Finds a client's own brand colour from their public website, for projects whose stored design profile carries no
// usable colour (it often holds button class names and text colours). Two sources, in this order:
//   1. <meta name="theme-color">: the colour the site itself declares for its brand;
//   2. the logo, when it is an SVG: its most-used fill that is a real colour (not white, black or grey).
// Pure suggestions: nothing here writes to the database. A person confirms, then sets sites.brand_color.

export function themeColorFromHtml(html) {
  const $ = cheerio.load(String(html || ''));
  const hex = normalizeHex($('meta[name="theme-color"]').first().attr('content'));
  return usable(hex) ? hex : null;
}

export function dominantSvgColor(svg) {
  const counts = new Map();
  for (const m of String(svg || '').matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    const hex = normalizeHex(m[1]);
    if (usable(hex)) counts.set(hex, (counts.get(hex) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

const svgFromDataUrl = (url) => {
  const m = /^data:image\/svg\+xml(;base64)?,(.*)$/s.exec(String(url || ''));
  if (!m) return null;
  try { return m[1] ? Buffer.from(m[2], 'base64').toString('utf8') : decodeURIComponent(m[2]); } catch { return null; }
};

export async function discoverBrandColor(siteUrl, { logoDataUrl = null } = {}) {
  const url = /^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`;
  const page = await fetchHtml(url);
  if (page.ok) {
    const hex = themeColorFromHtml(page.html);
    if (hex) return { ok: true, color: hex, source: 'theme-color meta tag' };
  }
  let logo = logoDataUrl;
  if (!logo) { const d = await discoverLogo(url); logo = d.ok ? d.dataUrl : null; }
  const svg = svgFromDataUrl(logo);
  const fromLogo = svg ? dominantSvgColor(svg) : null;
  if (fromLogo) return { ok: true, color: fromLogo, source: 'logo (SVG fill)' };
  return { ok: false, error: page.ok ? 'no theme-color and no usable SVG logo colour' : `couldn't load site: ${page.error}` };
}
