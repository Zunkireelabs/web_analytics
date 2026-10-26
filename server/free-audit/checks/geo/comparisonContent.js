const COMPARISON_PATTERNS = [
  /\bvs\.?\b/i,
  /\balternatives?\s+to\b/i,
  /\bbest\s+\w+\s+(for|to)\b/i,
  /\btop\s+\d+\b/i,
  /\bcompar(e|ison|ing)\b/i,
];

export default function comparisonContent({ $ }) {
  const headingsText = $('h1, h2, h3').map((i, el) => $(el).text()).get().join(' | ');
  const matched = COMPARISON_PATTERNS.filter((re) => re.test(headingsText));

  const found = matched.length >= 2;

  const score = matched.length >= 2 ? 10 : matched.length === 1 ? 5 : 0;

  return {
    id: 'comparison-content',
    title: 'Comparison / Best-Of Content',
    category: 'geo',
    passed: found,
    score,
    maxScore: 10,
    message: found
      ? 'Found comparison-style headings (e.g. "vs", "alternative to", "best X", "top N") — the content shape generative engines cite most.'
      : 'No comparison-style headings found (e.g. "X vs Y", "best X for Y", "top 10 X", "alternatives to X").',
    recommendation: found
      ? 'No action needed.'
      : 'Add a comparison, alternatives, or "best of" section — generative engines disproportionately cite this content shape when recommending brands.',
  };
};
