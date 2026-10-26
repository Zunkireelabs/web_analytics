export default function iframes({ $ }) {
  const count = $('iframe').length;
  const ok = count === 0;

  return {
    id: 'iframes',
    title: 'iFrames Used?',
    category: 'seo',
    passed: ok,
    score: ok ? 2 : 0,
    maxScore: 2,
    message: ok ? 'No iframes found on this page.' : `${count} iframe(s) found on this page.`,
    recommendation: ok
      ? 'No action needed.'
      : 'Search engines cannot always index iframe content — make sure critical content is not iframe-only.',
  };
};
