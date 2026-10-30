// Ready-to-paste fixes for the checks we can solve from the audited page alone.
// Nothing here invents facts: where real data is needed (ratings, authors,
// answers) the snippet carries an obvious REPLACE placeholder and a note.

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const json = (o) => JSON.stringify(o, null, 2);
const ld = (o) => `<script type="application/ld+json">\n${json(o)}\n</script>`;

function brandOf(report) {
  const host = new URL(report.finalUrl).hostname.replace(/^www\./, '');
  const title = report.pageMetadata?.title || '';
  const parts = title.split(/\s[|\-–—:·]\s|:\s/).map((p) => p.trim()).filter(Boolean);
  const short = (p) => p && p.split(/\s+/).length <= 4;
  if (parts.length > 1 && short(parts[parts.length - 1])) return parts[parts.length - 1];
  if (short(parts[0])) return parts[0];
  return host;
}

const GENERATORS = {
  'llms-txt': (r) => {
    const m = r.pageMetadata || {};
    const brand = brandOf(r);
    const sections = (m.headings || []).filter((h) => h.tag === 'h2').slice(0, 6).map((h) => `- ${h.text}`);
    return {
      title: 'Add an llms.txt file',
      language: 'markdown',
      where: `Save as ${new URL('/llms.txt', r.finalUrl)}`,
      code: [`# ${brand}`, '', `> ${m.description || 'REPLACE: one sentence on what you do and who for.'}`, '', '## Key pages', '', `- [${m.h1s?.[0] || brand}](${r.finalUrl}): ${clip(m.description || 'Homepage', 120)}`, '- [REPLACE: Pricing](REPLACE_URL): what a visitor finds there', '- [REPLACE: Docs or blog](REPLACE_URL): what a visitor finds there', ...(sections.length ? ['', '## On this page', '', ...sections] : [])].join('\n'),
      note: 'A guide for AI assistants. Add your most important pages with one line each.',
    };
  },
  'identity-schema': (r) => {
    const m = r.pageMetadata || {};
    return {
      title: 'Add Organization schema',
      language: 'html',
      where: 'Paste inside <head> on your homepage',
      code: ld({ '@context': 'https://schema.org', '@type': 'Organization', name: brandOf(r), url: new URL('/', r.finalUrl).href, description: m.description || 'REPLACE', logo: 'REPLACE_LOGO_URL', sameAs: ['REPLACE_LINKEDIN_URL', 'REPLACE_X_URL'] }),
      note: 'Tells AI exactly who you are, so it names you correctly.',
    };
  },
  'qa-content': (r) => {
    // Only reuse headings that already read as questions; inventing "What is <heading>?" gives nonsense.
    const isQuestion = (t) => t.endsWith('?') || /^(what|how|why|when|who|which|can|does|do|is|are|should)\b/i.test(t);
    const qs = (r.pageMetadata?.headings || []).filter((h) => ['h2', 'h3'].includes(h.tag) && h.text.length > 8 && isQuestion(h.text)).slice(0, 3);
    const questions = qs.length ? qs.map((h) => (h.text.endsWith('?') ? h.text : `${h.text}?`)) : ['REPLACE: a question your customers ask', 'REPLACE: another common question'];
    return {
      title: 'Add a FAQ section with FAQPage schema',
      language: 'html',
      where: 'Add a visible FAQ on the page, then paste this inside <head>',
      code: ld({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: questions.map((q) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: 'REPLACE: a direct 40-60 word answer, the same text shown on the page.' } })) }),
      note: 'AI assistants lift direct answers. The text in the schema must match what is visible on the page.',
    };
  },
  'freshness-signals': (r) => {
    const today = new Date().toISOString().slice(0, 10);
    return {
      title: 'Show when the page was published and updated',
      language: 'html',
      where: 'Add to <head>, plus the visible line in the page body',
      code: `<meta property="article:published_time" content="REPLACE_PUBLISH_DATE">\n<meta property="article:modified_time" content="${today}">\n\n<!-- visible in the page -->\n<p>Last updated <time datetime="${today}">${today}</time></p>`,
      note: 'Update the modified date whenever you materially change the page.',
    };
  },
  'author-expertise': (r) => ({
    title: 'Name an expert author',
    language: 'html',
    where: 'Paste inside <head> on pages with a clear author',
    code: ld({ '@context': 'https://schema.org', '@type': 'Article', headline: clip(r.pageMetadata?.h1s?.[0] || r.pageMetadata?.title || 'REPLACE', 110), author: { '@type': 'Person', name: 'REPLACE_AUTHOR_NAME', jobTitle: 'REPLACE_ROLE', url: 'REPLACE_PROFILE_URL' } }),
    note: 'Also show the author name and role on the page itself.',
  }),
  'review-rating-schema': (r) => ({
    title: 'Add review and rating schema',
    language: 'html',
    where: 'Paste inside <head> once you display real reviews on the page',
    code: ld({ '@context': 'https://schema.org', '@type': 'Organization', name: brandOf(r), aggregateRating: { '@type': 'AggregateRating', ratingValue: 'REPLACE_REAL_AVERAGE', reviewCount: 'REPLACE_REAL_COUNT' } }),
    note: 'Use only real, visible reviews. Made-up ratings break Google policy and can get you penalised.',
  }),
  'meta-description': (r) => {
    const m = r.pageMetadata || {};
    const base = m.h1s?.[0] ? `${m.h1s[0].replace(/[.!]$/, '')}. ${brandOf(r)} helps you REPLACE_BENEFIT.` : `${brandOf(r)}: REPLACE with what you offer and who it is for.`;
    return { title: 'Write a stronger meta description', language: 'html', where: 'Paste inside <head>', code: `<meta name="description" content="${clip(base, 155).replace(/"/g, '&quot;')}">`, note: 'Aim for 120-155 characters. Lead with the benefit and end with a reason to click.' };
  },
  'open-graph': (r) => {
    const m = r.pageMetadata || {};
    return { title: 'Add Open Graph tags', language: 'html', where: 'Paste inside <head>', code: [`<meta property="og:type" content="website">`, `<meta property="og:title" content="${(m.title || brandOf(r)).replace(/"/g, '&quot;')}">`, `<meta property="og:description" content="${(m.description || 'REPLACE').replace(/"/g, '&quot;')}">`, `<meta property="og:url" content="${r.finalUrl}">`, `<meta property="og:image" content="REPLACE_1200x630_IMAGE_URL">`].join('\n'), note: 'Controls how your link looks when shared on LinkedIn, Slack and WhatsApp.' };
  },
  'canonical-tag': (r) => ({ title: 'Add a canonical tag', language: 'html', where: 'Paste inside <head>', code: `<link rel="canonical" href="${r.finalUrl}">`, note: 'Tells Google which URL is the main version of this page.' }),
  'ai-crawler-access': (r) => ({
    title: 'Let AI crawlers read your site',
    language: 'text',
    where: `Add to ${new URL('/robots.txt', r.finalUrl)}`,
    code: ['GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended'].map((b) => `User-agent: ${b}\nAllow: /`).join('\n\n'),
    note: 'Only if you want to appear in AI answers. Review with your team before publishing.',
  }),
  'robots-txt': (r) => ({ title: 'Add a robots.txt', language: 'text', where: `Save as ${new URL('/robots.txt', r.finalUrl)}`, code: `User-agent: *\nAllow: /\n\nSitemap: ${new URL('/sitemap.xml', r.finalUrl)}`, note: 'Add Disallow lines for any private areas.' }),
  'comparison-content': (r) => {
    const b = brandOf(r);
    return { title: 'Publish comparison content', language: 'text', where: 'Create these pages or sections', code: [`${b} vs REPLACE_COMPETITOR: which is right for you?`, `Best REPLACE_CATEGORY tools for REPLACE_AUDIENCE`, `Alternatives to REPLACE_COMPETITOR`, `${b} pricing compared`].join('\n'), note: 'Use a table, be fair to competitors, and state who each option suits. AI quotes balanced comparisons.' };
  },
};

function fixFor(check, report) {
  const gen = GENERATORS[check.id];
  if (!gen) return null;
  try { return gen(report); } catch { return null; }
}

export { fixFor, brandOf };
