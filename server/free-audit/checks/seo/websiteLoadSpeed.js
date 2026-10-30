const MAX_LOAD_MS = 3000;

export default function websiteLoadSpeed({ render }) {
  if (!render || !render.available || render.loadTimeMs == null) {
    return {
      id: 'website-load-speed',
      title: 'Website Load Speed',
      category: 'seo',
      passed: null,
      score: 0,
      maxScore: 0,
      message: 'Load speed was not measured — enable JS render mode to check this.',
      recommendation: 'No action needed.',
    };
  }

  const ok = render.loadTimeMs <= MAX_LOAD_MS;

  return {
    id: 'website-load-speed',
    title: 'Website Load Speed',
    category: 'seo',
    passed: ok,
    score: ok ? 4 : 0,
    maxScore: 4,
    message: `Page reached network-idle in ${render.loadTimeMs}ms.`,
    recommendation: ok
      ? 'No action needed.'
      : `Load time exceeded ${MAX_LOAD_MS}ms — reduce render-blocking resources and optimize server response time.`,
  };
};
