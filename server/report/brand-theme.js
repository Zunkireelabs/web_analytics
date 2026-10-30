// Turns a client's brand colour into the small palette the client PDFs use.
//
// The accent is read from the site's own stored design profile
// (sites.url_file_map.siteRoot.designProfile.color.accent, see
// scripts/record-design-tokens.js), so every client gets its own colour. When
// that is missing or unusable (not a hex colour, or so grey / light / dark
// that it would look wrong as an accent) the report falls back to Zunkiree's
// own green, which is the brand colour of zunkireelabs.com (#76b900).
//
// A light accent such as Chayce's gold (#c8a96e) is too pale to use for small
// text on white, so `text` is the same hue darkened until it reaches WCAG AA
// contrast (4.5:1) against white. Everything else (tints, borders, bars) is the
// accent mixed with white, so one colour drives the whole document.

import { accentOf } from './brand.js';

export const ZUNKIREE_GREEN = '#76b900';

const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;

export function parseHex(input) {
  const m = HEX.exec(String(input ?? '').trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

export const toHex = ([r, g, b]) =>
  `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

function luminance([r, g, b]) {
  const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastWithWhite(rgb) {
  return 1.05 / (luminance(rgb) + 0.05);
}

function saturation([r, g, b]) {
  const max = Math.max(r, g, b) / 255; const min = Math.min(r, g, b) / 255;
  return max === 0 ? 0 : (max - min) / max;
}

const mixWithWhite = (rgb, amount) => rgb.map((v) => v + (255 - v) * (1 - amount));
const darken = (rgb, factor) => rgb.map((v) => v * factor);

// An accent is usable when it has real colour (not a grey), and is neither
// near-white (invisible on a white page) nor near-black (reads as plain text).
export function isUsableAccent(rgb) {
  if (!rgb) return false;
  const lum = luminance(rgb);
  return saturation(rgb) >= 0.2 && lum > 0.01 && lum < 0.8;
}

export function deriveBrandTheme(accentInput) {
  let rgb = parseHex(accentInput);
  let fellBack = false;
  if (!isUsableAccent(rgb)) { rgb = parseHex(ZUNKIREE_GREEN); fellBack = true; }

  let textRgb = rgb;
  for (let i = 0; i < 40 && contrastWithWhite(textRgb) < 4.5; i++) textRgb = darken(textRgb, 0.95);

  return {
    accent: toHex(rgb),
    text: toHex(textRgb),
    soft: toHex(mixWithWhite(rgb, 0.1)),
    border: toHex(mixWithWhite(rgb, 0.35)),
    bar: toHex(mixWithWhite(rgb, 0.55)),
    cover: toHex(mixWithWhite(rgb, 0.07)),
    fellBack,
  };
}

// Reads the client's colour off a sites row, by the same rule as the dashboard and the Google Docs (report/brand.js):
// sites.brand_color, else a real colour in the design profile (accent, any colour entry, the primary button).
export function accentFromSite(site) {
  const map = typeof site?.url_file_map === 'string' ? safeParse(site.url_file_map) : site?.url_file_map;
  return accentOf({ ...site, url_file_map: map });
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
