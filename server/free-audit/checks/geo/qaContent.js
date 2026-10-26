export default function qaContent({ $ }) {
  const headingsText = $('h1, h2, h3, h4').map((i, el) => $(el).text().toLowerCase()).get().join(' | ');
  const bodyText = $('body').text().toLowerCase();

  const questionPatterns = [
    /what is/i,
    /how (does|do|can|to)/i,
    /why (does|do|is|would)/i,
    /when (does|do|is|was)/i,
    /where (does|do|is|was)/i,
    /who (is|are|does|do)/i,
    /which (is|are|does|do)/i,
    /can (you|I|we)/i,
    /should (you|I|we)/i,
    /(will|would|could|might|shall).*(you|I|we|it)/i,
  ];

  const headingMatches = questionPatterns.filter((re) => re.test(headingsText));
  const bodyMatches = questionPatterns.filter((re) => re.test(bodyText));

  const totalMatches = headingMatches.length + bodyMatches.length;
  const found = totalMatches >= 2;

  let score;
  if (totalMatches >= 4) score = 10;
  else if (totalMatches >= 2) score = 7;
  else if (totalMatches >= 1) score = 3;
  else score = 0;

  return {
    id: 'qa-content',
    title: 'Q&A / Question-Style Content',
    category: 'geo',
    passed: found,
    score,
    maxScore: 10,
    message: totalMatches >= 2
      ? 'Found ' + totalMatches + ' question-style content signals — generative engines use these for direct answers.'
      : totalMatches === 1
      ? 'Only 1 question-style content signal found — add more Q&A headings or body content.'
      : 'No question-style content found — generative engines cannot extract direct answers from this page.',
    recommendation: totalMatches >= 2
      ? 'No action needed.'
      : 'Add question-style subheadings (e.g. "What is...", "How does...") and answer them in body content for direct-answer extraction by AI engines.',
  };
};
