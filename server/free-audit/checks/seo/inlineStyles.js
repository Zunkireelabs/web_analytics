export default function inlineStyles({ $ }) {
  const count = $('[style]').length;
  const ok = count === 0;

  return {
    id: 'inline-styles',
    title: 'Inline Styles',
    category: 'seo',
    passed: ok,
    score: ok ? 2 : 0,
    maxScore: 2,
    message: ok ? 'No inline styles found.' : `${count} element(s) use inline "style" attributes.`,
    recommendation: ok
      ? 'No action needed.'
      : 'Move inline styles into external stylesheets for better maintainability and caching.',
  };
};
