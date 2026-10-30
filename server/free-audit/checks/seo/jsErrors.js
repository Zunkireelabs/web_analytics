export default function jsErrors({ render }) {
  if (!render || !render.available || !render.consoleErrors) {
    return {
      id: 'js-errors',
      title: 'JavaScript Errors',
      category: 'seo',
      passed: null,
      score: 0,
      maxScore: 0,
      message: 'Console errors were not measured — enable JS render mode to check this.',
      recommendation: 'No action needed.',
    };
  }

  const count = render.consoleErrors.length;
  const ok = count === 0;

  return {
    id: 'js-errors',
    title: 'JavaScript Errors',
    category: 'seo',
    passed: ok,
    score: ok ? 3 : 0,
    maxScore: 3,
    message: ok ? 'No JavaScript console errors detected.' : `${count} JavaScript console error(s) detected.`,
    recommendation: ok ? 'No action needed.' : 'Fix JavaScript errors — they can break functionality and hurt user experience.',
  };
};
