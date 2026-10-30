export default function externalCitations({ $, finalUrl }) {
  let ownHostname;
  try {
    ownHostname = new URL(finalUrl).hostname.replace(/^www\./, '');
  } catch {
    ownHostname = null;
  }

  const externalDomains = new Set();
  $('article a[href], main a[href], body a[href]').each((i, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!/^https?:\/\//i.test(href)) return;
    try {
      const hostname = new URL(href).hostname.replace(/^www\./, '');
      if (ownHostname && hostname !== ownHostname) externalDomains.add(hostname);
    } catch {
      // ignore malformed hrefs
    }
  });

  const count = externalDomains.size;
  const found = count >= 3;

  let score;
  if (count >= 3) score = 10;
  else if (count === 2) score = 7;
  else if (count === 1) score = 3;
  else score = 0;

  return {
    id: 'external-citations',
    title: 'External Citations',
    category: 'geo',
    passed: found,
    score,
    maxScore: 10,
    message: found
      ? `Links out to ${count} distinct external domains — sourced content is more likely to be reused and cited by AI.`
      : count === 1
      ? 'Only 1 distinct external domain linked — add a few more authoritative sources.'
      : 'No links to external, authoritative sources found in the page content.',
    recommendation: found
      ? 'No action needed.'
      : 'Cite external, authoritative sources within your content. AI assistants favor well-sourced content when deciding what to reuse or recommend.',
  };
};
