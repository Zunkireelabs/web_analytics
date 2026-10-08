import { createHash } from 'node:crypto';

// Gradient blog covers: the soft, grainy mesh-gradient look zunkireelabs.com
// uses for its latest posts (a dark base, two blurred colour blobs low in the
// frame, film grain, no text on the image — the post template lays the title
// over it). Generated instead of searching a stock-photo library.
//
// It is an SVG on purpose. The Action Center commits TEXT files, so an SVG
// rides along with the post in the same commit, with no binary upload and no
// image library on the server. Output is deterministic: the same seed always
// produces the same cover, and different seeds pick different palettes.
//
// Opt-in per site (design is per tenant — never applied to another client):
//   url_file_map.newContentTargets['blog-outline'].cover =
//     { "style": "gradient", "dir": "src/assets/images/blog", "urlBase": "/assets/images/blog" }

export const GRADIENT_ALT = 'Abstract gradient background';
export const COVER_WIDTH = 1376;
export const COVER_HEIGHT = 768;

// Sampled from zunkireelabs.com's existing gradient covers (top of frame,
// bottom of frame, the two blobs). Each post gets one pair, so the blog reads
// as a family without every post looking identical.
export const ZUNKIREE_PALETTES = [
  { name: 'indigo',  top: '#292461', bottom: '#464782', left: '#3c86a6', right: '#6b3895' },
  { name: 'slate',   top: '#4a5a79', bottom: '#766e77', left: '#966d71', right: '#96897f' },
  { name: 'ember',   top: '#333f4b', bottom: '#4e5752', left: '#887343', right: '#395f65' },
  { name: 'plum',    top: '#4a2050', bottom: '#62536c', left: '#456877', right: '#8b6d7d' },
  { name: 'ocean',   top: '#2c4a73', bottom: '#5b7fa6', left: '#5f94c4', right: '#7a86b8' },
];

// Kept so existing imports and site 1's covers keep working.
export const PALETTES = ZUNKIREE_PALETTES;

const HEX = /^#[0-9a-f]{6}$/i;

function validPalette(p) {
  return p && ['top', 'bottom', 'left', 'right'].every((k) => HEX.test(String(p[k] || '')));
}

// The palettes a site is allowed to use: its OWN, from its cover config.
// These were previously Zunkireelabs's colours handed to ANY tenant that opted
// in — one client's brand shipped onto another's blog. Now:
//   1. cover.palettes in the tenant's own config (validated hex), else
//   2. Zunkireelabs's own palettes, for Zunkireelabs's own domain only
//      (so site 1's covers keep reproducing byte for byte), else
//   3. null — no cover is generated. Failing closed is the point: a missing
//      palette must never be filled with another client's brand.
export function palettesFor(site) {
  const own = site?.url_file_map?.newContentTargets?.['blog-outline']?.cover?.palettes;
  if (Array.isArray(own)) {
    const ok = own.filter(validPalette);
    if (ok.length) return ok;
  }
  const domain = String(site?.website_domain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
  if (domain === 'zunkireelabs.com') return ZUNKIREE_PALETTES;
  return null;
}

export function seedOf(text) {
  return parseInt(createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 8), 16);
}

// Small deterministic jitter so two posts on the same palette still differ.
function jitter(seed, salt, range) {
  const n = parseInt(createHash('sha1').update(`${seed}:${salt}`).digest('hex').slice(0, 6), 16) / 0xffffff;
  return Math.round((n - 0.5) * 2 * range);
}

export function gradientCoverSvg(seedText, { width = COVER_WIDTH, height = COVER_HEIGHT, palettes = ZUNKIREE_PALETTES } = {}) {
  const seed = seedOf(seedText);
  const p = palettes[seed % palettes.length];
  const flip = (seed >> 3) % 2 === 1;
  const [leftColor, rightColor] = flip ? [p.right, p.left] : [p.left, p.right];
  const lx = Math.round(width * 0.20) + jitter(seed, 'lx', 45);
  const rx = Math.round(width * 0.76) + jitter(seed, 'rx', 45);
  const ly = Math.round(height * 0.66) + jitter(seed, 'ly', 36);
  const ry = Math.round(height * 0.66) + jitter(seed, 'ry', 36);
  const lrx = Math.round(width * 0.27) + jitter(seed, 'lrx', 30);
  const rrx = Math.round(width * 0.25) + jitter(seed, 'rrx', 30);
  const rad = Math.round(height * 0.22);
  const grainSeed = (seed % 90) + 1;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${GRADIENT_ALT}">` +
    '<defs>' +
    `<linearGradient id="base" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.top}"/><stop offset="0.7" stop-color="${p.top}"/><stop offset="1" stop-color="${p.bottom}" stop-opacity="0.6"/></linearGradient>` +
    `<filter id="blur" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="${Math.round(height * 0.13)}"/></filter>` +
    `<filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.62" numOctaves="2" seed="${grainSeed}" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncR type="linear" slope="2.4" intercept="-0.65"/><feFuncG type="linear" slope="2.4" intercept="-0.65"/><feFuncB type="linear" slope="2.4" intercept="-0.65"/></feComponentTransfer></filter>` +
    '</defs>' +
    `<rect width="${width}" height="${height}" fill="url(#base)"/>` +
    `<ellipse cx="${lx}" cy="${ly}" rx="${lrx}" ry="${rad}" fill="${leftColor}" filter="url(#blur)" opacity="1"/>` +
    `<ellipse cx="${rx}" cy="${ry}" rx="${rrx}" ry="${rad}" fill="${rightColor}" filter="url(#blur)" opacity="1"/>` +
    `<rect width="${width}" height="${height}" filter="url(#grain)" opacity="1" style="mix-blend-mode:overlay"/>` +
    '</svg>\n'
  );
}

// The cover config for a site, or null when the site did not opt in (then the
// generator keeps its existing behaviour). Only a complete, well-formed config
// counts; a half-written one is ignored rather than guessed at.
export function coverConfigFor(site) {
  const c = site?.url_file_map?.newContentTargets?.['blog-outline']?.cover;
  if (!c || c.style !== 'gradient') return null;
  const dir = String(c.dir || '').replace(/^\/+|\/+$/g, '');
  const urlBase = String(c.urlBase || '').replace(/\/+$/g, '');
  if (!dir || !urlBase.startsWith('/')) return null;
  return { style: 'gradient', dir, urlBase };
}

// slug: the post's own file slug (so the cover is unique per post and easy to
// find next to it). Returns the file to commit and the front-matter values.
export function buildGradientCover(site, { slug }) {
  const cfg = coverConfigFor(site);
  const safe = String(slug || '').trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!cfg || !safe) return null;
  const palettes = palettesFor(site);
  if (!palettes) return null;
  return {
    file: { path: `${cfg.dir}/${safe}.svg`, content: gradientCoverSvg(safe, { palettes }), contentFormat: 'asset' },
    featuredImage: { url: `${cfg.urlBase}/${safe}.svg`, alt: GRADIENT_ALT, photographer: null },
  };
}
