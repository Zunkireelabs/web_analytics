const MAX_BYTES = 100 * 1024;

export default function pageWeight({ html }) {
  const bytes = Buffer.byteLength(html, 'utf8');
  const kb = Math.round(bytes / 1024);
  const ok = bytes <= MAX_BYTES;

  return {
    id: 'page-weight',
    title: 'Website Download Size (HTML)',
    category: 'seo',
    passed: ok,
    score: ok ? 3 : 0,
    maxScore: 3,
    message: `HTML document is ${kb}KB.`,
    recommendation: ok
      ? 'No action needed.'
      : `Trim the HTML document below ${Math.round(MAX_BYTES / 1024)}KB where possible — smaller pages load faster.`,
  };
};
