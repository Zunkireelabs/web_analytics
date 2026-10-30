export default function jsRenderGap({ $, render }) {
  const rawText = $('body').clone().find('script, style, noscript').remove().end().text().replace(/\s+/g, ' ').trim();
  const rawLength = rawText.length;

  const { available, text: renderedText } = render || { available: false, text: null };

  if (!available) {
    return {
      id: 'js-render-gap',
      title: 'Rendered Content (LLM Readability)',
      category: 'aeo',
      passed: null,
      score: 0,
      maxScore: 0,
      message: 'Playwright is not installed — this check was skipped.',
      recommendation: 'Install the optional "playwright" package to enable this check.',
    };
  }

  if (renderedText === null || renderedText.length === 0) {
    return {
      id: 'js-render-gap',
      title: 'Rendered Content (LLM Readability)',
      category: 'aeo',
      passed: null,
      score: 0,
      maxScore: 0,
      message: 'Could not render this page for comparison.',
      recommendation: 'No action needed.',
    };
  }

  const ratio = Math.min(1, rawLength / renderedText.length);
  const pass = ratio >= 0.8;

  return {
    id: 'js-render-gap',
    title: 'Rendered Content (LLM Readability)',
    category: 'aeo',
    passed: pass,
    score: Math.round(Math.min(1, ratio / 0.8) * 4),
    maxScore: 4,
    message: `Raw HTML contains ${Math.round(ratio * 100)}% of the rendered page's visible text.`,
    recommendation: pass
      ? 'No action needed.'
      : 'Much of this page\'s content only appears after JavaScript execution — most LLM crawlers read raw HTML and may miss it. Consider server-side rendering key content.',
  };
};
