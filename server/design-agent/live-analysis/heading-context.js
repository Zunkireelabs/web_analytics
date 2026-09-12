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
export function resolveHeadingClasses(profile, { tag, sectionRole } = {}) {
  const heading = profile?.typography?.heading || {};
  if (tag === 'h1') {
    const page = heading.page || {};
    if (sectionRole === 'hero') return page.hero || page.standard || heading.item || heading.section || null;
    return page.standard || page.hero || heading.item || heading.section || null;
  }
  if (tag === 'h2') return heading.section || heading.item || null;
  return heading.item || heading.section || null;
}
