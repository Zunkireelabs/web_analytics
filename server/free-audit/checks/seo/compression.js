export default function compression({ headers }) {
  const encoding = (headers['content-encoding'] || '').toLowerCase();
  const compressed = /gzip|br|deflate/.test(encoding);

  return {
    id: 'compression',
    title: 'Compression Usage (Gzip/Brotli)',
    category: 'seo',
    passed: compressed,
    score: compressed ? 3 : 0,
    maxScore: 3,
    message: compressed ? `Response is compressed (${encoding}).` : 'Response is not compressed.',
    recommendation: compressed
      ? 'No action needed.'
      : 'Enable gzip or Brotli compression on the server to reduce transfer size and improve load time.',
  };
};
