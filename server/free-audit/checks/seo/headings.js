export default function headings({ $ }) {
  const h1Count = $('h1').length;
  const subCount = $('h2, h3, h4, h5, h6').length;

  const results = [];

  results.push({
    id: 'h1-usage',
    title: 'H1 Header Tag Usage',
    category: 'seo',
    passed: h1Count === 1,
    score: h1Count === 1 ? 6 : 0,
    maxScore: 6,
    message:
      h1Count === 0
        ? 'No H1 tag found.'
        : h1Count === 1
        ? 'Exactly one H1 tag found.'
        : `${h1Count} H1 tags found (should be exactly 1).`,
    recommendation: h1Count === 1 ? 'No action needed.' : 'Use exactly one H1 tag per page as the main heading.',
  });

  results.push({
    id: 'subheading-usage',
    title: 'H2-H6 Header Tag Usage',
    category: 'seo',
    passed: subCount > 0,
    score: subCount > 0 ? 3 : 0,
    maxScore: 3,
    message: subCount > 0 ? `${subCount} subheading tag(s) found.` : 'No H2-H6 subheadings found.',
    recommendation: subCount > 0 ? 'No action needed.' : 'Use H2-H6 tags to structure your content into sections.',
  });

  return results;
};
