export default function friendlyUrl({ finalUrl }) {
  const url = new URL(finalUrl);
  const path = url.pathname;
  const hasQueryCruft = [...url.searchParams.keys()].some((k) =>
    /^(sid|sessionid|phpsessid|utm_|ref|fbclid)/i.test(k)
  );
  const hasMessyExtension = /\.(php|aspx|jsp)$/i.test(path) && /\d{3,}/.test(path);
  const friendly = !hasQueryCruft && !hasMessyExtension;

  return {
    id: 'friendly-url',
    title: 'Friendly Links',
    category: 'seo',
    passed: friendly,
    score: friendly ? 3 : 0,
    maxScore: 3,
    message: friendly ? 'URL structure looks clean and readable.' : `URL "${path}${url.search}" looks unfriendly.`,
    recommendation: friendly
      ? 'No action needed.'
      : 'Use clean, hyphenated, human-readable URLs without session IDs or tracking cruft.',
  };
};
