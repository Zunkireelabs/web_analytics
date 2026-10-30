export default function answerability({ $ }) {
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();

  const candidates = $('p')
    .toArray()
    .map((el) => $(el).text().replace(/\s+/g, ' ').trim())
    .filter((text) => text.length >= 40);

  if (candidates.length === 0) {
    return {
      id: 'answerability',
      title: 'Answerability (Content Clarity)',
      category: 'aeo',
      passed: false,
      score: 0,
      maxScore: 5,
      message: 'No substantive paragraph found on this page.',
      recommendation: 'Add clear, substantive paragraph content that states the page\'s core topic/answer plainly.',
    };
  }

  const firstSubstantive = candidates[0];
  const snippet = firstSubstantive.slice(0, 40);
  const idx = bodyText.indexOf(snippet);
  const early = idx >= 0 && idx <= 500;

  return {
    id: 'answerability',
    title: 'Answerability (Content Clarity)',
    category: 'aeo',
    passed: early,
    score: early ? 5 : 2,
    maxScore: 5,
    message: early
      ? 'A substantive paragraph appears early in the page content.'
      : 'The first substantive paragraph appears late in the page (buried behind other content).',
    recommendation: early
      ? 'No action needed.'
      : 'Move clear, substantive answer content earlier in the raw HTML so it is easy for AI crawlers and readers to find.',
  };
};
