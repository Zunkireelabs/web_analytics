// HOW THIS SITE'S OWN POSTS ARE BUILT, read from the posts themselves (never from the landing-page design profile).
//
// The rule: a new post is built exactly like the posts the site already has. The design profile describes the site's landing pages: its heading, paragraph and link
// classes are section-scale classes, and its page wrapper holds a whole landing section. Copying them onto a blog post gave SuperRank headings and paragraphs
// classed `h2` / `lead` / `link-arrow` inside a `container section` its 102 posts never use, Chayce its landing theme's `v2-h2` / `body-copy` / `text-link`, and
// Zunkiree a wrapper with extra `max-w-2xl px-4 …` classes (2026-11-26). Each site's blog layout already styles article text, so the right body is the one the
// existing posts have.
//
// Pure: it takes the raw text of sibling posts and returns a small description, or null when there is too little evidence (then the caller does what it did before).

const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const MIN_SIBLINGS = 3;

/** What ONE existing post's body does: its single outer wrapper (`<div class="…"> … </div>` around everything), and whether its headings/paragraphs/links carry classes. */
export function bodySignature(raw) {
  const body = String(raw || '').replace(FRONT_MATTER, '').trim();
  if (!body) return null;
  let wrapper = null;
  const open = /^<div\s+class="([^"]*)"\s*>/i.exec(body);
  if (open && /<\/div>\s*$/i.test(body)) {
    // The first <div> must be the one the last </div> closes, or this is a leading block, not a wrapper around the post.
    let depth = 0; let closesAtEnd = false;
    for (const m of body.matchAll(/<div\b[^>]*>|<\/div>/gi)) {
      if (m[0][1] === '/') depth--; else depth++;
      if (depth === 0) { closesAtEnd = m.index + m[0].length >= body.length - 1; break; }
    }
    if (closesAtEnd) wrapper = open[1].trim().replace(/\s+/g, ' ');
  }
  const inner = wrapper ? body.replace(/^<div[^>]*>/i, '') : body;
  // Only the article's own text counts. A classed block inside it (a FAQ accordion, a help box, a table wrapper) styles itself and says nothing about how the body prose is written.
  const classedProse = /<(h[1-6]|p)\b[^>]*\sclass="[^"]+"/i.test(withoutBlocks(inner));
  return { wrapper, classedProse };
}

// The text with every nested <div>/<section>/<details>/<dl>/<aside>/<table> block taken out (tracked by depth, so a block inside a block goes too).
function withoutBlocks(html) {
  let out = ''; let depth = 0; let last = 0;
  for (const m of html.matchAll(/<(\/?)(div|section|details|dl|aside|table)\b[^>]*>/gi)) {
    if (!m[1]) { if (depth === 0) { out += html.slice(last, m.index); } depth++; }
    else if (depth > 0) { depth--; if (depth === 0) last = m.index + m[0].length; }
  }
  return depth === 0 ? out + html.slice(last) : out;
}

/** The style most of the site's posts share. Needs at least MIN_SIBLINGS posts; a value is taken only when MORE THAN HALF of them agree, so one odd post decides nothing. */
export function bodyStyleFromSignatures(signatures) {
  const sigs = (signatures || []).filter(Boolean);
  if (sigs.length < MIN_SIBLINGS) return null;
  const counts = new Map();
  for (const s of sigs) counts.set(s.wrapper, (counts.get(s.wrapper) || 0) + 1);
  let wrapper = null; let n = 0;
  for (const [w, c] of counts) if (c > n) { wrapper = w; n = c; }
  if (n <= sigs.length / 2) wrapper = null; // no wrapper is shared by most posts: add none
  const classed = sigs.filter((s) => s.classedProse).length;
  return { wrapper, classedProse: classed > sigs.length / 2, samples: sigs.length };
}
