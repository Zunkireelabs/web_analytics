const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'your', 'you', 'are', 'was',
  'were', 'have', 'has', 'will', 'can', 'not', 'all', 'but', 'about', 'into', 'their',
  'they', 'them', 'than', 'then', 'when', 'what', 'how', 'why', 'who',
]);

function significantWords(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
}

export default function keywordConsistency({ $ }) {
  const title = ($('title').first().text() || '').trim();
  const titleWords = [...new Set(significantWords(title))];

  if (titleWords.length === 0) {
    return {
      id: 'keyword-consistency',
      title: 'Keyword Consistency',
      category: 'seo',
      passed: null,
      score: 0,
      maxScore: 0,
      message: 'No title tag available to derive a target keyword from.',
      recommendation: 'Add a descriptive title tag first.',
    };
  }

  const h1Text = ($('h1').first().text() || '').toLowerCase();
  const bodyText = $('body').clone().find('script, style, noscript').remove().end().text().toLowerCase();

  const inH1 = titleWords.filter((w) => h1Text.includes(w));
  const inBody = titleWords.filter((w) => bodyText.includes(w));
  const ratio = inBody.length / titleWords.length;
  const pass = ratio >= 0.5 && inH1.length > 0;

  return {
    id: 'keyword-consistency',
    title: 'Keyword Consistency',
    category: 'seo',
    passed: pass,
    score: Math.round(Math.min(1, ratio) * 4) + (inH1.length > 0 ? 2 : 0),
    maxScore: 6,
    message: `${inBody.length}/${titleWords.length} title keyword(s) also appear in the body; ${
      inH1.length > 0 ? 'target keyword found in H1' : 'no title keyword found in H1'
    }.`,
    recommendation: pass
      ? 'No action needed.'
      : 'Make sure your primary title keyword also appears in the H1 and is reinforced naturally throughout the body content.',
  };
};
