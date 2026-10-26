export default function canonical({ $, finalUrl }) {
  const href = $('link[rel="canonical"]').attr('href');

  if (!href) {
    return {
      id: 'canonical-tag',
      title: 'Canonical Tag',
      category: 'seo',
      passed: false,
      score: 0,
      maxScore: 5,
      message: 'No canonical tag found.',
      recommendation: 'Add a <link rel="canonical"> tag pointing to the preferred URL for this page.',
    };
  }

  let resolved;
  try {
    resolved = new URL(href, finalUrl);
  } catch {
    return {
      id: 'canonical-tag',
      title: 'Canonical Tag',
      category: 'seo',
      passed: false,
      score: 0,
      maxScore: 5,
      message: `Canonical tag has an unparseable URL: "${href}".`,
      recommendation: 'Fix the canonical tag to point to a valid absolute URL.',
    };
  }

  return {
    id: 'canonical-tag',
    title: 'Canonical Tag',
    category: 'seo',
    passed: true,
    score: 5,
    maxScore: 5,
    message: `Canonical tag points to ${resolved.toString()}.`,
    recommendation: 'No action needed.',
  };
};
