export default function hreflang({ $ }) {
  const tags = $('link[rel="alternate"][hreflang]');

  if (tags.length === 0) {
    return {
      id: 'hreflang',
      title: 'Hreflang Usage',
      category: 'seo',
      passed: null,
      score: 0,
      maxScore: 0,
      message: 'No hreflang tags found (not applicable for single-language sites).',
      recommendation: 'If you serve multiple languages/regions, add hreflang tags to indicate alternate versions.',
    };
  }

  const values = tags.map((_, el) => $(el).attr('hreflang')).get();
  const duplicates = values.length !== new Set(values).size;

  return {
    id: 'hreflang',
    title: 'Hreflang Usage',
    category: 'seo',
    passed: !duplicates,
    score: duplicates ? 1 : 3,
    maxScore: 3,
    message: `${values.length} hreflang tag(s) found${duplicates ? ' with duplicate values' : ''}.`,
    recommendation: duplicates ? 'Remove duplicate hreflang values.' : 'No action needed.',
  };
};
