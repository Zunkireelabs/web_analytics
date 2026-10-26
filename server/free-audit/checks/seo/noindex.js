export default function noindex({ $, headers }) {
  const metaContent = ($('meta[name="robots"]').attr('content') || '').toLowerCase();
  const headerValue = (headers['x-robots-tag'] || '').toLowerCase();
  const blocked = metaContent.includes('noindex') || headerValue.includes('noindex');

  return {
    id: 'noindex-check',
    title: 'Noindex Tag Test',
    category: 'seo',
    passed: !blocked,
    score: blocked ? 0 : 8,
    maxScore: 8,
    message: blocked
      ? 'This page is marked noindex and will be excluded from search results.'
      : 'This page is not blocked by a noindex directive.',
    recommendation: blocked
      ? 'Remove the noindex directive (meta tag or X-Robots-Tag header) if you want this page to be indexed.'
      : 'No action needed.',
  };
};
