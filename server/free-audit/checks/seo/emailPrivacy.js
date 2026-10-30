export default function emailPrivacy({ $ }) {
  const exposed = $('a[href^="mailto:"]').length;
  const ok = exposed === 0;

  return {
    id: 'email-privacy',
    title: 'Email Privacy',
    category: 'seo',
    passed: ok,
    score: ok ? 2 : 0,
    maxScore: 2,
    message: ok ? 'No plaintext email links found.' : `${exposed} plaintext "mailto:" link(s) found — exposed to spam harvesters.`,
    recommendation: ok
      ? 'No action needed.'
      : 'Obfuscate email addresses or use a contact form instead of plaintext mailto: links.',
  };
};
