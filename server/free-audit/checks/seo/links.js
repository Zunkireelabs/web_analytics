export default function links({ $, finalUrl }) {
  const host = new URL(finalUrl).hostname;
  let internal = 0;
  let external = 0;

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    try {
      const resolved = new URL(href, finalUrl);
      if (resolved.hostname === host) internal += 1;
      else external += 1;
    } catch {
      // ignore unparseable hrefs
    }
  });

  const total = internal + external;
  const ok = internal > 0;

  return {
    id: 'on-page-links',
    title: 'On-Page Links',
    category: 'seo',
    passed: ok,
    score: ok ? 4 : 0,
    maxScore: 4,
    message: `${total} link(s) found: ${internal} internal, ${external} external.`,
    recommendation: ok ? 'No action needed.' : 'Add internal links to help users and search engines navigate your site.',
  };
};
