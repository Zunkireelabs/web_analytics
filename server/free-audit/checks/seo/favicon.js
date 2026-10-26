export default function favicon({ $ }) {
  const found = $('link[rel~="icon"]').length > 0 || $('link[rel="shortcut icon"]').length > 0;

  return {
    id: 'favicon',
    title: 'Favicon',
    category: 'seo',
    passed: found,
    score: found ? 2 : 0,
    maxScore: 2,
    message: found ? 'Favicon link tag found.' : 'No favicon link tag found.',
    recommendation: found ? 'No action needed.' : 'Add a <link rel="icon"> tag pointing to a favicon file.',
  };
};
