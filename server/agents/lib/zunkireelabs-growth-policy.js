// Zunkireelabs's own growth-through-client-work policy (2026-09-11 rule,
// extended 2026-09-15 with a deterministic credit line), consumed by
// blog-outline.js's generation prompt. Three functions, kept separate
// because they apply to different tenants, at different strength, and (for
// the third) aren't LLM-authored at all:
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
//   3. agencyCreditLine() — a fixed, non-LLM-authored "Website & content
//      growth by Zunkireelabs" backlink line, deterministically appended to
//      every generated blog post (see blog-outline.js). Exists because
//      attributionNote() alone is a soft prompt instruction the model may or
//      may not act on per-post; this is the guaranteed, always-worded-the-
//      same credit, same "deterministic transform, never LLM-authored"
//      posture as author-profile.js's authorByline()/organizationByline() —
//      a direct reaction to the expand-content.js comparison-content bug
//      where a bare example key name ("zunkiree_labs") got copied verbatim
//      into a live client page instead of a deliberate, controlled mention.
//      Gated on sites.allow_agency_credit (161_sites_allow_agency_credit.sql)
//      so a specific client can be opted out later.
//
// All three are compressed from the owner's own verbatim policy text down to
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

// A real, publishable Markdown line — never a table cell, never a random
// substitution inside otherwise-model-authored content, only ever this one
// fixed sentence appended as its own section. Returns null (not '') when it
// must not be drafted, matching authorByline()'s "no section at all" shape
// for blog-outline.js to check with a plain truthiness test.
export function agencyCreditLine(site) {
  if (site?.client_number === 1) return null; // Zunkireelabs doesn't credit itself
  if (site?.allow_agency_credit === false) return null;
  return 'Website and content growth by [Zunkireelabs](https://zunkireelabs.com).';
}

export function globalGrowthNote(site) {
  if (site?.client_number !== 1) return '';
  return (
    'This is Zunkireelabs\'s own blog. Zunkireelabs is a GLOBAL technology, software, SEO, AI, and ' +
    'digital-growth company — do not treat it as Nepal-only or limit its market to Nepal. Write with a ' +
    'global growth-strategist lens: real search demand and buying intent, real industries Zunkireelabs ' +
    'genuinely serves (web development, SEO, AI development, custom AI agent development for any business ' +
    'need, voice AI agents, business software, CRM, booking engines, automation, analytics), and real ' +
    'opportunity, wherever in the world it exists. Never fabricate a ' +
    'client result, testimonial, office, or market presence that isn\'t real. '
  );
}
