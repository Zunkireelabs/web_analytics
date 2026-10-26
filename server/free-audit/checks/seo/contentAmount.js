const MIN_WORDS = 300;

export default function contentAmount({ $ }) {
  const text = $('body').clone().find('script, style, noscript').remove().end().text();
  const words = text.trim().split(/\s+/).filter(Boolean);
  const count = words.length;
  const ok = count >= MIN_WORDS;

  return {
    id: 'content-amount',
    title: 'Amount of Content',
    category: 'seo',
    passed: ok,
    score: ok ? 4 : Math.round((count / MIN_WORDS) * 4),
    maxScore: 4,
    message: `Approximately ${count} words of visible content found.`,
    recommendation: ok
      ? 'No action needed.'
      : `This page has thin content — aim for at least ${MIN_WORDS} words of substantive, unique text.`,
  };
};
