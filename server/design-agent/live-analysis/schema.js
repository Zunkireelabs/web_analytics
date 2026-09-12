// Design Profile v2 — the shape the live-site analysis pipeline
// (capture.js -> segment.js -> profile-extract.js) produces, and the one
// design-drift.js persists via persistDesignProfile.
//
// Deliberately backward-compatible at the top level: `typography`, `color`,
// `spacing`, `layout`, `components`, `responsive` keep the exact field names
// v1 (the OpenHands-derived profile) used, because design-profile.js's
// projectors (projectFaq/projectQaContent/projectExpandContent/
// projectInternalLinks/projectContentWrapper) read those and nothing about
// how a component template is composed needed to change — only how the
// profile ITSELF gets derived changed (live site analysis instead of a
// Docker/OpenHands repo read). What's new is additive: `pages`,
// `pageTypePatterns`, `navigation`, `site`, `evidence` — the deeper
// structural understanding (page flow, section hierarchy, per-page-type
// patterns) generators can draw on for content/voice grounding
// (server/implementers/lib/marker-merge.js, newpage-render.js), on top of
// the flat design-system vocabulary the projectors already consume.
//
// `lastCheckedAt` (ISO string, live-analysis-handler.js /
// design-drift.js's refreshDesignProfileCheckedAt) is separate from
// `derivedAt` (design-profile.js's stampDesignProfile): `derivedAt` only
// moves when the profile's CONTENT was actually re-derived from an LLM
// call; `lastCheckedAt` moves every time the weekly rescan's fresh capture
// was compared against this profile and found no meaningful drift, so a
// profile can show it was verified current far more recently than it was
// last (re)derived.
export const DESIGN_PROFILE_VERSION = 2;

export const PAGE_TYPES = Object.freeze([
  'homepage', 'service', 'location', 'landing', 'faq',
  'blog-listing', 'blog-article', 'legal', 'other',
]);

// URL-shape heuristics only — there is no pageType concept anywhere else in
// this repo (url_file_map, discover-content-target.js) to defer to. Ordered
// most-specific first; falls through to 'other' rather than guessing.
export function classifyPageType(url) {
  let path = '/';
  try { path = new URL(url).pathname.toLowerCase(); } catch { return 'other'; }
  if (path === '/' || path === '') return 'homepage';
  if (/\/(blog|articles?|news)\/?$/.test(path)) return 'blog-listing';
  if (/\/(blog|articles?|news)\/.+/.test(path)) return 'blog-article';
  if (/\/(faq|faqs|help|support)\b/.test(path)) return 'faq';
  if (/\/(terms|privacy|cookies?|legal)\b/.test(path)) return 'legal';
  if (/\/(services?|solutions?|products?)\b/.test(path)) return 'service';
  if (/\/(locations?|offices?|areas?)\b/.test(path)) return 'location';
  if (/\/(landing|lp)\b/.test(path)) return 'landing';
  return 'other';
}

// Structural completeness only, same discipline as v1's validateDesignProfile
// (design-profile.js) — this deliberately does NOT judge whether the fields
// are GOOD, only whether the projectors and page-type consumers have what
// they need to run at all.
export function validateDesignProfileV2(profile) {
  const errors = [];
  if (!profile || typeof profile !== 'object') return { ok: false, errors: ['No design profile.'] };
  if (profile.version !== DESIGN_PROFILE_VERSION) {
    errors.push(`Unsupported design profile version ${profile.version} (expected ${DESIGN_PROFILE_VERSION}).`);
  }
  if (!profile.typography?.body) errors.push('typography.body is required — it is the base text style every projection builds on.');
  if (!profile.typography?.heading?.item) errors.push('typography.heading.item is required — the style used for a repeating item heading (an FAQ question, a section title).');
  if (!profile.layout?.container && !profile.layout?.prose) {
    errors.push('layout needs at least one of container/prose — the wrapper every block is placed inside.');
  }
  if (profile.pages !== undefined && !Array.isArray(profile.pages)) errors.push('pages, when present, must be an array.');
  if (profile.pageTypePatterns !== undefined && (typeof profile.pageTypePatterns !== 'object' || profile.pageTypePatterns === null)) {
    errors.push('pageTypePatterns, when present, must be an object.');
  }
  return { ok: errors.length === 0, errors };
}

// One page's structural facts as captured/segmented, and what
// profile-extract.js asks the model to describe about it. Documented here
// (not enforced at runtime) as the contract between segment.js's output and
// profile-extract.js's input.
//
// {
//   url: string,
//   pageType: PAGE_TYPES[number],
//   title: string,
//   sections: [{
//     role: string,               // 'header' | 'hero' | 'content' | 'cta' | 'testimonials' | 'pricing' | 'faq' | 'footer' | ...
//     order: number,               // 0-based position on the page
//     alignment: 'left'|'center'|'right',
//     width: 'narrow'|'normal'|'wide'|'full',
//     textHierarchy: [{ role: 'eyebrow'|'heading'|'subheading'|'body'|'cta'|'link', text, tag, style, classes }],
//     // 'link' is capture.js's pickLink() result: the block's real inline
//     // link, already excluded from anything button-shaped (background
//     // color, or a btn/button class name) — never the same element as a
//     // 'cta' entry above. This is the real evidence
//     // design-drift.js's role verification checks typography.link
//     // against, so a template that mistook a CTA button for the site's
//     // inline-link style (correctLinkTypography's whole reason to exist)
//     // has something real to be verified against.
//     components: string[],        // e.g. ['card', 'button', 'accordion']
//     spacing: { before: number|null, after: number|null }, // px gap to neighbours
//     imagery: { count: number, hasBackground: boolean },
//     precedes: string|null,       // role of the next section
//     follows: string|null,        // role of the previous section
//   }],
// }
