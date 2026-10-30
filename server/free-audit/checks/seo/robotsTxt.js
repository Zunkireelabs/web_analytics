export default function robotsTxt({ robotsTxt }) {
  const results = [];

  results.push({
    id: 'robots-txt',
    title: 'Robots.txt',
    category: 'seo',
    passed: robotsTxt.present === true,
    score: robotsTxt.present === true ? 5 : 0,
    maxScore: robotsTxt.present === null ? 0 : 5,
    message:
      robotsTxt.present === true
        ? 'robots.txt file found.'
        : robotsTxt.present === false
        ? 'No robots.txt file found.'
        : 'Could not verify robots.txt.',
    recommendation: robotsTxt.present === true ? 'No action needed.' : 'Add a robots.txt file to guide search engine crawlers.',
  });

  results.push({
    id: 'blocked-by-robots',
    title: 'Blocked by Robots.txt',
    category: 'seo',
    passed: robotsTxt.present === true ? !robotsTxt.blocksAll : null,
    score: robotsTxt.present === true && !robotsTxt.blocksAll ? 5 : 0,
    maxScore: robotsTxt.present === true ? 5 : 0,
    message: robotsTxt.blocksAll
      ? 'robots.txt disallows all crawlers via "Disallow: /" for User-agent: *.'
      : 'This site does not appear to be blocked entirely by robots.txt.',
    recommendation: robotsTxt.blocksAll
      ? 'Remove the blanket "Disallow: /" rule if you want this site to be crawled.'
      : 'No action needed.',
  });

  return results;
};
