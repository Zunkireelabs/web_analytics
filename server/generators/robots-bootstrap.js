// Pure, deterministic generator — no LLM call. Handles the case robots-fix.js
// doesn't: a site with NO robots.txt at all, optionally carrying real,
// evidence-backed Disallow rules for URL patterns technical-seo.js's
// legacy-index-spam check found in this site's OWN real GSC data that don't
// belong to this site at all (a prior owner's/hacker's URLs still crawled
// under this domain). Always additive-safe: `Allow: /` first, so a site with
// no matching spam pattern still gets a normal, permissive baseline file.
//
// Deliberately a full-file write (server/implementers/backend.js's
// pushRobotsBootstrapBranch), not a hash-marker splice like robots-fix.js —
// there is no existing file to splice into. The Disallow rules ARE still
// wrapped in the same SEOAI:ROBOTS-FIX marker convention so a later
// robots-fix draft (un-blocking one specific real page) can still splice
// into this file once it exists.

export const meta = {
  id: 'robots-bootstrap',
  name: 'Robots.txt Bootstrap Generator',
  description: 'Drafts a baseline robots.txt for a site that has none, optionally blocking real legacy-spam URL patterns found in this site\'s own Search Console data.',
  recommendationTags: [],
};

// params: { disallowPatterns?: string[] } — real path/param patterns
// technical-seo:site:legacy-index-spam found, never guessed.
export async function generate({ params }) {
  const patterns = Array.isArray(params?.disallowPatterns) ? params.disallowPatterns.filter(Boolean) : [];

  const lines = ['User-agent: *', 'Allow: /'];
  if (patterns.length) {
    lines.push(
      '',
      '# SEOAI:ROBOTS-FIX:START',
      '# Legacy/spam paths found indexed under this domain that this site',
      '# never had (see Search Console for details) — blocked so Google stops',
      '# wasting crawl budget on them.',
      ...patterns.map((p) => `Disallow: ${p}`),
      '# SEOAI:ROBOTS-FIX:END',
    );
  }
  const robotsTxt = `${lines.join('\n')}\n`;

  return {
    content: { robotsTxt, disallowPatterns: patterns },
    summary: patterns.length
      ? `New robots.txt blocking ${patterns.length} legacy-spam pattern(s): ${patterns.join(', ')}.`
      : 'New baseline robots.txt (Allow: /).',
  };
}
