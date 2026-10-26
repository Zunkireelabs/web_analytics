const DEPRECATED_TAGS = ['font', 'center', 'marquee', 'blink', 'applet', 'basefont', 'big', 'strike', 'tt'];

export default function deprecatedHtml({ $ }) {
  const found = DEPRECATED_TAGS.filter((tag) => $(tag).length > 0);
  const ok = found.length === 0;

  return {
    id: 'deprecated-html',
    title: 'Deprecated HTML Tags',
    category: 'seo',
    passed: ok,
    score: ok ? 2 : 0,
    maxScore: 2,
    message: ok ? 'No deprecated HTML tags found.' : `Deprecated tag(s) found: ${found.join(', ')}.`,
    recommendation: ok ? 'No action needed.' : 'Replace deprecated HTML tags with modern semantic HTML and CSS.',
  };
};
