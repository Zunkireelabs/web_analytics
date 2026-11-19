const result = (passed, score, message, recommendation) => ({
  id: 'canonical-tag',
  title: 'Canonical Tag',
  category: 'seo',
  passed,
  score,
  maxScore: 5,
  message,
  recommendation,
});

export default function canonical({ $, finalUrl, canonicalTarget }) {
  const tags = $('link[rel="canonical"]')
    .map((_, el) => ($(el).attr('href') || '').trim())
    .get()
    .filter(Boolean);
  const href = tags[0];

  if (!href) {
    return result(false, 0, 'No canonical tag found.', 'Add a <link rel="canonical"> tag pointing to the preferred URL for this page.');
  }

  let resolved;
  try {
    resolved = new URL(href, finalUrl);
  } catch {
    return result(false, 0, `Canonical tag has an unparseable URL: "${href}".`, 'Fix the canonical tag to point to a valid absolute URL.');
  }

  // Google ignores the canonical entirely when a page declares conflicting ones.
  const distinct = new Set(tags.map((t) => { try { return new URL(t, finalUrl).toString(); } catch { return t; } }));
  if (distinct.size > 1) {
    return result(false, 1, `Page declares ${distinct.size} different canonical URLs (${[...distinct].slice(0, 3).join(', ')}); search engines ignore conflicting canonicals.`, 'Keep exactly one <link rel="canonical"> tag. Check your theme, SEO plugin and any hard-coded tag.');
  }

  // The canonical must point at a page that can actually be indexed.
  if (canonicalTarget?.checked) {
    if (canonicalTarget.status >= 400) {
      return result(false, 0, `Canonical points to ${resolved.toString()}, which returns HTTP ${canonicalTarget.status}.`, 'Point the canonical at a live page, usually this page itself.');
    }
    if (canonicalTarget.redirectedTo) {
      return result(false, 2, `Canonical points to ${resolved.toString()}, which redirects to ${canonicalTarget.redirectedTo}.`, 'Point the canonical straight at the final URL, not at a URL that redirects.');
    }
    if (canonicalTarget.noindex) {
      return result(false, 2, `Canonical points to ${resolved.toString()}, which is marked noindex.`, 'Point the canonical at an indexable page, or remove noindex from the target.');
    }
  }

  return result(true, 5, `Canonical tag points to ${resolved.toString()}${canonicalTarget?.checked ? ' (target responds normally).' : '.'}`, 'No action needed.');
};
