export default function twitterCard({ $ }) {
  const card = ($('meta[name="twitter:card"]').attr('content') || '').trim();

  return {
    id: 'twitter-card',
    title: 'X (Twitter) Cards',
    category: 'seo',
    passed: !!card,
    score: card ? 2 : 0,
    maxScore: 2,
    message: card ? `twitter:card set to "${card}".` : 'No twitter:card meta tag found.',
    recommendation: card ? 'No action needed.' : 'Add a twitter:card meta tag (e.g. "summary_large_image").',
  };
};
