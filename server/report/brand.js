// Per-client report branding. The colour is the client's own: an explicit sites.brand_color if one is set, else a real
// colour from their design profile (see accentOf). The rest (what to print on top of it, a text-safe shade, a pale tile tint) is derived here so a
// light brand colour can never produce unreadable white-on-gold text. A project with no usable colour gets the
// Zunkiree green, never a colour that belongs to another client.
export const FALLBACK = '#76b900';
const WHITE = '#ffffff';
const INK = '#171717';

const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;
export function normalizeHex(v) {
  const m = HEX.exec(String(v ?? '').trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return `#${h.toLowerCase()}`;
}

// The design profile stores utility classes, sometimes with the real colour inline ('bg-[#0D1282]'); a named class
// ('text-zunkiree-600') carries no colour we can read, so it yields null rather than a guess.
export function hexFromAccent(v) {
  const s = String(v ?? '');
  const inline = /\[(#[0-9a-f]{3,6})\]/i.exec(s);
  return normalizeHex(inline ? inline[1] : s);
}

const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`;

// WCAG relative luminance and contrast ratio.
const lum = (hex) => {
  const [r, g, b] = toRgb(hex).map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// Blend `hex` toward `other` (0 = hex, 1 = other).
export const mix = (hex, other, ratio) => {
  const a = toRgb(hex), b = toRgb(other);
  return toHex(a.map((c, i) => c + (b[i] - c) * ratio));
};

// What to print on the band. The band text is large and bold, where WCAG asks for 3:1, so white stays whenever it
// reaches that (a mid green or blue keeps white text); only a genuinely light brand colour gets dark text.
export const onColor = (bg) => (contrast(bg, WHITE) >= 3 ? WHITE : INK);

// Darken until the colour is readable as text on white (4.5:1), for tile numbers and links.
export function textSafe(hex) {
  let c = hex;
  for (let i = 0; i < 12 && contrast(c, WHITE) < 4.5; i += 1) c = mix(c, '#000000', 0.12);
  return c;
}

// Grey and near-white accents make a lifeless report band, so they are skipped like a missing colour.
const usable = (hex) => {
  if (!hex) return false;
  const [r, g, b] = toRgb(hex);
  return Math.max(r, g, b) - Math.min(r, g, b) >= 40 && lum(hex) < 0.85;
};

// Where a project's colour can come from, in order:
//   1. sites.brand_color: set by a person who knows the brand, so it wins (migration 214);
//   2. a real colour in the design profile: the accent, any other colour entry, or the primary button (the design
//      profile often stores utility classes like 'text-blue-dark', which carry no colour, but 'bg-[#0D1282]' does);
//   3. nothing usable: the caller falls back to the Zunkiree green.
export function accentOf(site) {
  const own = normalizeHex(site?.brand_color);
  if (own) return own;
  const dp = site?.url_file_map?.siteRoot?.designProfile;
  const candidates = [dp?.color?.accent, ...Object.values(dp?.color || {}), dp?.components?.button?.primary];
  for (const c of candidates) {
    const hex = hexFromAccent(c);
    if (usable(hex)) return hex;
  }
  return null;
}

// The project's own website as people say it: no protocol, no 'www.', no path ('https://admizzeducation.com/' ->
// 'admizzeducation.com'). null when the project has none recorded.
export function websiteOf(site) {
  const raw = String(site?.website_domain || '').trim();
  if (!raw) return null;
  try { return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./i, '') || null; } catch { return null; }
}

export function resolveBrand(site) {
  const color = accentOf(site) || FALLBACK;
  return {
    name: site?.name || 'Your site',
    website: websiteOf(site),
    color,                       // the header band
    onColor: onColor(color),     // text printed on the band
    text: textSafe(color),       // tile numbers, accents on white
    tint: mix(color, WHITE, 0.9),// pale tile background
    bar: color,                  // the highlighted bar
    barSoft: mix(color, WHITE, 0.72),
    custom: color !== FALLBACK,
  };
}

export const rgbColor = (hex) => { const [r, g, b] = toRgb(hex); return { color: { rgbColor: { red: r / 255, green: g / 255, blue: b / 255 } } }; };

// What the dashboard's report pages need to paint a project's own band, tiles and bars.
export function brandPayload(site) {
  const b = resolveBrand(site);
  return { name: b.name, website: b.website, color: b.color, onColor: b.onColor, text: b.text, tint: b.tint, barSoft: b.barSoft, custom: b.custom, logoDataUrl: site?.logo_data_url || null };
}
