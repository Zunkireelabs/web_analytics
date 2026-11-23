// Structural evidence that a page's own source ALREADY carries a FAQ written the way the site writes it, in forms the older
// signals (a templating loop, or an "accordion"-style keyword next to the word FAQ) never matched.
//
// Real incident, 2026-11-23 (an Astro site, blog posts in Markdown): eight pages that already had a FAQ were each given a
// second one — seven as hidden FAQPage JSON-LD with different, invented questions, one as an unstyled visible list — because
// the FAQ was written as Markdown (`## FAQ` / `## Quick FAQ` followed by `### Question?` headings or `**Question?** answer`
// paragraphs), or as a `<section class="faq-x">` block whose class names contain none of the accordion keywords.
//
// Both checks need a FAQ-named heading AND real questions under it (or a FAQ-classed element AND FAQ wording), so a nav link
// that merely says "FAQ" does not count. Callers strip tool-managed markers first: our own empty or filled markers are never
// the site's FAQ.

const FAQ_HEADING = /^(#{2,4})[ \t]+(?:\d+\.[ \t]*)?(?:quick[ \t]+)?(?:faqs?|frequently[ \t]+asked[ \t]+questions)\b[^\n]*$/gim;
const QUESTION_LINE = /^(?:#{3,6}[ \t]+[^\n]*\?[ \t]*$|(?:[-*][ \t]+)?\*\*[^*\n]+\?\*\*)/m;
const FAQ_CLASS = /\bclass(?:Name)?\s*=\s*["'{][^"'}]*\bfaq[\w-]*/i;
const FAQ_WORDING = /frequently asked questions|\bfaqs?\b/i;

// Markdown: a FAQ-named heading with at least one question line before the next heading of the same or higher level.
export function findMarkdownFaqSection(text) {
  const src = String(text || '');
  FAQ_HEADING.lastIndex = 0;
  let m;
  while ((m = FAQ_HEADING.exec(src))) {
    const level = m[1].length;
    const bodyStart = m.index + m[0].length;
    const rest = src.slice(bodyStart);
    const stop = rest.search(new RegExp(`^#{1,${level}}[ \\t]`, 'm'));
    const body = stop < 0 ? rest : rest.slice(0, stop);
    if (QUESTION_LINE.test(body)) return { start: m.index, end: bodyStart + body.length, heading: m[0].trim(), level, body };
  }
  return null;
}

export function hasMarkdownFaqSection(text) {
  return findMarkdownFaqSection(text) !== null;
}

// Markup: an element whose class names contain "faq" (faq-x, faq__list, styles.faq …) on a page that also says FAQ.
export function hasFaqClassedSection(text) {
  const src = String(text || '');
  return FAQ_CLASS.test(src) && FAQ_WORDING.test(src);
}

export function hasExistingFaqStructure(text) {
  return hasMarkdownFaqSection(text) || hasFaqClassedSection(text);
}

// The page's own questions and answers, verbatim, from a Markdown FAQ section (both `### Q?` + answer paragraphs and
// `**Q?** answer` paragraphs). Used to build FAQPage schema from what the page really says instead of inventing questions.
export function extractMarkdownFaqItems(text) {
  const section = findMarkdownFaqSection(text);
  if (!section) return [];
  const items = [];
  const lines = section.body.split('\n');
  let current = null;
  const push = () => { if (current && current.answer.trim()) items.push({ question: current.question.trim(), answer: current.answer.trim() }); };
  for (const line of lines) {
    const h = /^#{3,6}[ \t]+(.*\?)[ \t]*$/.exec(line);
    const b = /^(?:[-*][ \t]+)?\*\*([^*\n]+\?)\*\*[ \t]*(.*)$/.exec(line);
    if (h) { push(); current = { question: h[1], answer: '' }; continue; }
    if (b) { push(); current = { question: b[1], answer: b[2] || '' }; continue; }
    if (current) current.answer += (current.answer ? ' ' : '') + line.trim();
  }
  push();
  return items.map(({ question, answer }) => ({ question, answer: answer.replace(/\s+/g, ' ').trim() }));
}
