// Resolves which of a site's OWN observed heading class strings applies to a
// specific (tag, sectionRole) context — e.g. an h1 in a hero section vs an
// h1 on a standard/interior template — instead of forcing every heading of
// the same tag to match one flat sitewide convention (profile-extract.js's
// typography.heading.item, which is really meant for h3-level repeating item
// headings like an FAQ question).
//
// Every value read here comes from THIS site's own stored Design Profile
// (typography.heading.page.hero/.standard, populated by
// headingPageSamplesByContext/correctHeadingTypography in profile-extract.js)
// — a profile with no hero-context evidence simply falls back to whatever
// this site DOES have real evidence for; it never borrows a value from
// another tenant's profile or from a hardcoded default.
//
// h3/h4 ("item") headings get the same page-type scoping h1 already had.
// Found live on admizzeducation.com: a country-landing page's small
// icon-card caption ("Fall Intake", h4) and a blog-article's in-article
// subheading ("What Is the COMPEX Scholarship?", h4) are each the dominant,
// internally-consistent style for their OWN page type — but the flat
// sitewide `heading.item` can only hold ONE of them, so whichever page type
// the profile happened to sample from became "the" convention and the
// other page type's equally legitimate heading got flagged as drift
// (and, depending which page a later profile refresh sampled, the flagged
// and "correct" class strings could even swap — a self-contradictory
// recommendation pair, not real drift). `pageTypePatterns[pageType]
// .textHierarchy`'s 'subheading' entry is real, grounded, per-page-type
// evidence (profile-extract.js's correctPageTypeTextHierarchy verifies it
// against that exact page type's own observed h2-h4 elements before this
// ever reads it) — checked first, falling back to the flat convention only
// when this page type has no grounded value of its own.
export function resolveHeadingClasses(profile, { tag, sectionRole, pageType, pageTypePatterns } = {}) {
  const heading = profile?.typography?.heading || {};
  if (tag === 'h1') {
    const page = heading.page || {};
    if (sectionRole === 'hero') return page.hero || page.standard || heading.item || heading.section || null;
    return page.standard || page.hero || heading.item || heading.section || null;
  }
  if (tag === 'h2') return heading.section || heading.item || null;

  const scoped = (pageTypePatterns?.[pageType]?.textHierarchy || [])
    .find((item) => item.role === 'subheading' && item.classes);
  if (scoped) return scoped.classes;

  return heading.item || heading.section || null;
}
