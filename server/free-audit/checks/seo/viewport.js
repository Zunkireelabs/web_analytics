export default function viewport({ $ }) {
  const content = ($('meta[name="viewport"]').attr('content') || '').trim();
  const ok = /width\s*=\s*device-width/i.test(content);

  return {
    id: 'mobile-viewport',
    title: 'Use of Mobile Viewports',
    category: 'seo',
    passed: ok,
    score: ok ? 5 : 0,
    maxScore: 5,
    message: content ? `Viewport meta tag: "${content}".` : 'No mobile viewport meta tag found.',
    recommendation: ok
      ? 'No action needed.'
      : 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> for mobile-friendliness.',
  };
};
