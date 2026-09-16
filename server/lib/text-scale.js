// Font-size reasoning over real Tailwind class strings, in the one notation-
// agnostic place both the render-time guards (implementers/lib/marker-merge.js)
// and the profile derivation (design-agent/live-analysis/profile-extract.js)
// can share. Deliberately dependency-free so either side can import it without
// dragging llm.js (and its test-time module mocks) across a module boundary —
// same reasoning design-drift.js's own normalizeClasses copy documents.
//
// The gap this closes: every size guard in this codebase was written against
// NAMED Tailwind scales (`text-3xl`, `md:text-5xl`) only. A site whose
// Tailwind config expresses type in arbitrary values instead — `text-[50px]`,
// `md:text-[3.5rem]`, extremely common in real client repos — matched none of
// those patterns, so every guard silently passed it through. Confirmed live on
// admizzeducation.com, whose heading classes are arbitrary-value throughout:
// its FAQ questions shipped at `md:text-[50px]`, larger than the site's own
// 42px section headings, because the strip rule could not see them at all.

// text-3xl is 1.875rem/30px in a default Tailwind config, and is the point
// every existing guard here already treats as "section headline scale" (see
// BLOG_UNSAFE_HEADING_SIZE_RE's own note: 3xl and up is section scale in
// virtually every real config, 2xl and below is ordinary subheading scale).
// Expressed in px so arbitrary values can be judged on the same line as named
// ones instead of by a second, drifting rule.
export const SECTION_SCALE_MIN_PX = 30;

const NAMED_SCALE_PX = {
  xs: 12, sm: 14, base: 16, lg: 18, xl: 20,
  '2xl': 24, '3xl': 30, '4xl': 36, '5xl': 48,
  '6xl': 60, '7xl': 72, '8xl': 96, '9xl': 128,
};

// Strips any responsive/state prefix (`md:`, `lg:`, `hover:`, `group-hover:`)
// so a variant is judged by the size it actually sets. A class that sets a
// size only at a breakpoint still sets that size on real screens.
const VARIANT_PREFIX_RE = /^(?:[\w-]+:)+/;

// px for a single font-size utility, or null when the class is not a
// font-size at all (`font-bold`, `leading-tight`, `text-gray-600` — note that
// last one: `text-<color>` shares the `text-` prefix and must never be read as
// a size). Unparseable arbitrary values (`text-[var(--h1)]`, `text-[2vw]`)
// return null on purpose: "cannot tell" is not "is fine", and every caller
// here treats null as no evidence rather than as a pass.
export function textClassPx(cls) {
  const bare = String(cls || '').replace(VARIANT_PREFIX_RE, '');
  if (!bare.startsWith('text-')) return null;
  const value = bare.slice('text-'.length);

  const arbitrary = /^\[(-?[\d.]+)(px|rem|em)\]$/.exec(value);
  if (arbitrary) {
    const n = parseFloat(arbitrary[1]);
    if (!Number.isFinite(n)) return null;
    return arbitrary[2] === 'px' ? n : n * 16;
  }

  return Object.prototype.hasOwnProperty.call(NAMED_SCALE_PX, value) ? NAMED_SCALE_PX[value] : null;
}

// Whether this one class sets a section-headline-scale font size, in EITHER
// notation. The replacement for every bare `text-(3xl|4xl|...)` regex test.
export function isSectionScaleTextClass(cls) {
  const px = textClassPx(cls);
  return px != null && px >= SECTION_SCALE_MIN_PX;
}

// The largest font size any class in a full class string sets, or null when
// the string sets none. Responsive type is written as a ramp
// (`text-[28px] sm:text-[36px] md:text-[50px]`), and the visual defect always
// shows at the TOP of that ramp — judging by the first or the unprefixed
// value reads a 50px heading as a 28px one.
export function maxTextPx(classes) {
  let max = null;
  for (const token of String(classes || '').split(/\s+/)) {
    const px = textClassPx(token);
    if (px != null && (max == null || px > max)) max = px;
  }
  return max;
}

// A fixed height (`h-[70px]`, `h-16`) is never a valid vertical-rhythm or
// spacing convention: it is the measured height of whatever single element
// happened to be captured, and it clips or overlaps any content of a
// different length. Real spacing is padding/margin. Lives here next to the
// size predicates because it is the same class of question — "is this
// captured value semantically valid for the slot it landed in" — and both
// the profile derivation and the render-time strip need the same answer.
const FIXED_HEIGHT_RE = /^(?:[\w-]+:)?h-(?:\[[^\]]+\]|\d+|screen|full)$/;
export function isFixedHeightClass(cls) {
  return FIXED_HEIGHT_RE.test(String(cls || ''));
}

// True when a whole class string contains nothing BUT fixed-height/empty
// tokens — i.e. it carries no real spacing information and storing it as a
// spacing convention would be storing a measurement mistake.
export function isFixedHeightOnly(classes) {
  const tokens = String(classes || '').split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every(isFixedHeightClass);
}
