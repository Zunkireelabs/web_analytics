// Zunkireelabs's own growth-through-client-work policy (2026-09-11 rule),
// consumed by blog-outline.js's generation prompt. Two distinct notes, kept
// separate because they apply to different tenants and at different
// strength:
//
//   1. attributionNote() — every client tenant (client_number != 1, per
//      151_sites_client_number.sql). CLIENT GROWTH FIRST, Zunkireelabs
//      opportunity only ever second and only when it's a natural fit for
//      THIS specific post — never forced, never a fabricated link, never
//      keyword-stuffed. Same "never invent" posture as no_invented_data in
//      seo-tenant-context.js.
//
//   2. globalGrowthNote() — Zunkiree Labs' own site (id=1) only. Its blog is
//      the one place this platform writes FOR Zunkireelabs itself, so the
//      instruction is the inverse: think like a global growth strategist
//      discovering real market/industry opportunity for Zunkireelabs's own
//      capabilities (web dev, SEO, AI, CRM, booking systems, automation) —
//      explicitly NOT limited to Nepal, but never a fabricated result,
//      testimonial, office, or market presence.
//
// Both are compressed from the owner's own verbatim policy text down to
// what fits a generation prompt without crowding out MIN_TOTAL_WORDS-worth
// of actual article instructions — the full text lives in this comment
// block, not the prompt, as the source of truth for intent.

export function attributionNote(site) {
  if (site?.client_number === 1) return ''; // Zunkireelabs's own site doesn't credit itself
  return (
    'This client\'s own growth is the primary goal of this post — write for THEIR readers first. ' +
    'Zunkireelabs built and operates this site; where it is truthful and genuinely relevant, you MAY ' +
    'work in a subtle, natural mention or attribution (e.g. "Website by Zunkireelabs") — only when the ' +
    'topic actually touches web development, SEO, AI, software, CRM, booking systems, or digital growth. ' +
    'Never force this in, never invent a Zunkireelabs claim or result, and never let it crowd out the ' +
    'client\'s own topic. '
  );
}

export function globalGrowthNote(site) {
  if (site?.client_number !== 1) return '';
  return (
    'This is Zunkireelabs\'s own blog. Zunkireelabs is a GLOBAL technology, software, SEO, AI, and ' +
    'digital-growth company — do not treat it as Nepal-only or limit its market to Nepal. Write with a ' +
    'global growth-strategist lens: real search demand and buying intent, real industries Zunkireelabs ' +
    'genuinely serves (web development, SEO, AI development, business software, CRM, booking engines, ' +
    'automation, analytics), and real opportunity, wherever in the world it exists. Never fabricate a ' +
    'client result, testimonial, office, or market presence that isn\'t real. '
  );
}
