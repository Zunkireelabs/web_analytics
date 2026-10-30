export default function analyticsTracking({ $ }) {
  let found = false;

  $('script').each((_, el) => {
    if (found) return;
    const src = ($(el).attr('src') || '').toLowerCase();
    if (src.includes('googletagmanager.com') || src.includes('google-analytics.com')) {
      found = true;
      return;
    }
    const body = $(el).contents().text();
    if (/\bgtag\s*\(|\bga\s*\(\s*['"]create['"]/.test(body)) {
      found = true;
    }
  });

  return {
    id: 'analytics-tracking',
    title: 'Analytics Tracking Tool',
    category: 'seo',
    passed: found,
    score: found ? 3 : 0,
    maxScore: 3,
    message: found ? 'An analytics tracking tool (Google Analytics/GTM) was detected.' : 'No analytics tracking tool detected.',
    recommendation: found
      ? 'No action needed.'
      : 'Install an analytics tool (e.g. Google Analytics or Google Tag Manager) to measure traffic and behavior.',
  };
};
