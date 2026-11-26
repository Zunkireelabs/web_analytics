// Native Markdown for content written into a Markdown/MDX page (a blog post in src/content/blog/*.md and the like).
//
// Why this exists (2026-11-23, an Astro site): every marker value was built as HTML from a component template — and where
// the site had no captured template for the component, from a projection or a built-in default. On a Markdown post that
// produced a raw, unstyled <dl class="section"> FAQ after the "Related guides" list, while the site's own posts write a FAQ
// as `## Frequently asked questions` + `### Question?` and its renderer turns exactly that into the site's accordion.
//
// For a Markdown page the source of truth for "how this component looks" is the site's OWN other pages in the same
// collection: the heading they use, how questions are written, how related links are listed, where the section sits.
// Everything here is learned from those siblings and nothing is invented: when no sibling shows the component, the
// caller holds the draft instead of guessing.

import { findMarkdownFaqSection } from '../../lib/existing-faq.js';

export const MARKDOWN_NATIVE_TYPES = new Set(['faq', 'qa-content', 'internal-links', 'expand-content', 'refresh-content']);

// Pure. A Markdown page with no sibling showing a FAQ / related-links list may use the site's captured component template instead of
// being refused, but only for those two "no convention" refusals and only when such a template exists. Every other refusal still holds.
export function canUseCapturedTemplateInstead(reason, hasCapturedTemplate) {
  return Boolean(hasCapturedTemplate) && (reason === 'no-markdown-faq-convention' || reason === 'no-markdown-related-convention');
}

export function isMarkdownFile(filePath) {
  return /\.mdx?$/i.test(String(filePath || ''));
}

const RELATED_HEADING = /^(#{2,4})[ \t]+((?:related|further reading|see also|read next|more (?:guides|reading|articles))[^\n]*)$/im;
const LINK_ITEM = /^[-*][ \t]+\[[^\]]+\]\([^)]+\)(.*)$/;
const MD_TABLE = /^\s*\|.*\|\s*$\n^\s*\|?\s*:?-{3,}/m;

function stripFrontMatter(text) {
  return String(text || '').replace(/^---\n[\s\S]*?\n---\n?/, '');
}

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) if (v != null) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null; let n = 0;
  for (const [v, c] of counts) if (c > n) { best = v; n = c; }
  return best;
}

function headingAfter(body, index) {
  const m = /^#{1,6}[ \t]+[^\n]*$/m.exec(body.slice(index));
  return m ? m[0].trim() : null;
}

// Pure. `siblings` = raw Markdown sources of other pages in the same collection (front matter allowed).
export function learnMarkdownConventions(siblings) {
  const faq = []; const related = []; const sectionLevels = []; let tables = 0;
  for (const raw of siblings || []) {
    const body = stripFrontMatter(raw);
    const section = findMarkdownFaqSection(body);
    if (section) {
      const style = /^#{3,6}[ \t]+[^\n]*\?[ \t]*$/m.test(section.body) ? 'heading' : 'bold';
      faq.push({ heading: section.heading, level: section.level, style, before: headingAfter(body, section.end) });
    }
    const rel = RELATED_HEADING.exec(body);
    if (rel) {
      const after = body.slice(rel.index + rel[0].length).split('\n').filter((l) => l.trim());
      const items = after.filter((l) => LINK_ITEM.test(l));
      if (items.length) related.push({ heading: rel[0].trim(), withNote: items.some((l) => /^:\s+\S/.test(LINK_ITEM.exec(l)[1].trim())) });
    }
    for (const m of body.matchAll(/^(#{2,3})[ \t]+\S/gm)) sectionLevels.push(m[1].length);
    if (MD_TABLE.test(body)) tables += 1;
  }
  const faqHeading = mostCommon(faq.map((f) => f.heading));
  const faqPick = faq.find((f) => f.heading === faqHeading) || null;
  const relHeading = mostCommon(related.map((r) => r.heading));
  return {
    faq: faqPick ? {
      heading: faqHeading,
      level: faqPick.level,
      style: mostCommon(faq.filter((f) => f.heading === faqHeading).map((f) => f.style)),
      before: mostCommon(faq.map((f) => f.before).filter(Boolean)),
    } : null,
    related: relHeading ? { heading: relHeading, withNote: related.filter((r) => r.withNote).length * 2 >= related.length } : null,
    sectionLevel: mostCommon(sectionLevels) || 2,
    usesTables: tables > 0,
    sampleCount: (siblings || []).length,
  };
}

function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function tableToMarkdown(table) {
  if (!Array.isArray(table) || !table.length) return '';
  const cols = Object.keys(table[0] || {});
  if (!cols.length) return '';
  const cell = (v) => oneLine(v).replace(/\|/g, '\\|');
  return [
    `| ${cols.map(cell).join(' | ')} |`,
    `| ${cols.map(() => '---').join(' | ')} |`,
    ...table.map((row) => `| ${cols.map((c) => cell(row?.[c] ?? '')).join(' | ')} |`),
  ].join('\n');
}

function relativeHref(url) {
  try { const u = new URL(url); return u.pathname + u.search + u.hash; } catch { return String(url || ''); }
}

// Pure. Renders a draft's content as Markdown in the site's own conventions.
// Returns { ok: true, value, placeBefore } or { ok: false, reason, error } — never a guessed format.
export function renderMarkdownNative(actionType, content, conventions, { fileBody = '' } = {}) {
  const conv = conventions || {};
  if (actionType === 'faq' || actionType === 'qa-content') {
    if (!conv.faq) return { ok: false, reason: 'no-markdown-faq-convention', error: 'No other page in this collection has a FAQ section to copy the format from, so none is invented.' };
    if (findMarkdownFaqSection(stripFrontMatter(fileBody))) {
      return { ok: false, reason: 'page-has-own-faq', error: 'This page already has its own FAQ section; a second one is never added.' };
    }
    const items = (content?.items || []).filter((i) => oneLine(i?.question) && oneLine(i?.answer));
    if (!items.length) return { ok: false, reason: 'empty', error: 'The draft has no questions to write.' };
    const qLevel = '#'.repeat(Math.min(conv.faq.level + 1, 6));
    const rows = items.map(({ question, answer }) => (conv.faq.style === 'bold'
      ? `**${oneLine(question)}** ${oneLine(answer)}`
      : `${qLevel} ${oneLine(question)}\n\n${oneLine(answer)}`));
    return { ok: true, value: `\n\n${conv.faq.heading}\n\n${rows.join('\n\n')}\n\n`, placeBefore: conv.faq.before || null };
  }
  if (actionType === 'internal-links') {
    const links = (content?.suggestions || []).filter((s) => s?.targetUrl && s?.anchorText);
    if (!links.length) return { ok: false, reason: 'empty', error: 'The draft has no links to write.' };
    const line = (s) => `- [${oneLine(s.anchorText)}](${relativeHref(s.targetUrl)})${conv.related?.withNote && oneLine(s.rationale || s.targetTitle) ? `: ${oneLine(s.targetTitle || s.rationale)}` : ''}`;
    const body = stripFrontMatter(fileBody);
    // The page already has its own related list: the new links join THAT list (marker placed after its last item),
    // never a second "Related guides" heading.
    if (RELATED_HEADING.test(body)) return { ok: true, value: `\n${links.map(line).join('\n')}\n`, appendToRelatedList: true };
    if (!conv.related) return { ok: false, reason: 'no-markdown-related-convention', error: 'No other page in this collection has a related-links list to copy the format from, so none is invented.' };
    return { ok: true, value: `\n\n${conv.related.heading}\n${links.map(line).join('\n')}\n\n`, placeBefore: null };
  }
  if (actionType === 'expand-content' || actionType === 'refresh-content') {
    const sections = (content?.sections || []).filter((s) => oneLine(s?.heading) && String(s?.body || '').trim());
    if (!sections.length) return { ok: false, reason: 'empty', error: 'The draft has no sections to write.' };
    const hasTable = sections.some((s) => (Array.isArray(s.table) && s.table.length) || MD_TABLE.test(String(s.body || '')));
    if (hasTable && !conv.usesTables) return { ok: false, reason: 'no-markdown-table-convention', error: 'No other page in this collection uses a table, so one is not introduced here.' };
    const h = '#'.repeat(conv.sectionLevel || 2);
    const md = sections.map((s) => [`${h} ${oneLine(s.heading)}`, String(s.body).trim(), tableToMarkdown(s.table)].filter(Boolean).join('\n\n'));
    // New body sections belong in the article, above the FAQ / related list that close a post. The page's OWN closing heading decides
    // (it is the line that really exists in this file); the site's usual heading is only the fallback, because a post that words its
    // heading differently would otherwise get no placement at all and the section would land below the FAQ.
    return { ok: true, value: `\n\n${md.join('\n\n')}\n\n`, placeBefore: ownClosingHeading(fileBody)?.heading || conv.faq?.heading || conv.related?.heading || null };
  }
  return { ok: false, reason: 'unsupported', error: `${actionType} has no native Markdown form.` };
}

// The first of the page's own closing sections: its FAQ or its "Related guides" list, whichever comes first. New body content must go
// above this line. { heading, index } (index into the body without front matter), or null when the page has neither.
export function ownClosingHeading(fileBody) {
  const body = stripFrontMatter(fileBody);
  const found = [];
  const faq = findMarkdownFaqSection(body);
  if (faq) found.push({ heading: faq.heading, index: faq.start });
  const rel = RELATED_HEADING.exec(body);
  if (rel) found.push({ heading: rel[0].trim(), index: rel.index });
  return found.sort((x, y) => x.index - y.index)[0] || null;
}

// Pure. The rule for body sections (expand-content / refresh-content): they must not sit below the page's FAQ or Related guides.
// Checked on the file AFTER placement, so it covers every way a marker can end up low: a marker that already held content (never moved),
// a heading the placement could not find, or a page whose marker was set up at the end of the file. null = fine, otherwise a plain reason.
export function expandedContentBelowClosingSection(fileContent, markerName) {
  const src = String(fileContent || '');
  const at = src.indexOf(`<!-- SEOAI:${markerName}:START -->`);
  if (at < 0) return null;
  const closing = ownClosingHeading(src.slice(0, at));
  return closing
    ? `The "${markerName}" slot sits below this page's "${closing.heading.replace(/^#+\s*/, '')}" section, so new body content would land under the FAQ or related links. Move the slot above that section (it already holds content, so it is not moved automatically), then apply again.`
    : null;
}

// Pure. Moves an EMPTY marker pair for `markerName` so the section lands where the site puts it:
//  - placeBefore: just above the first heading line equal to that text (e.g. above "## Related guides");
//  - appendToRelatedList: inline at the end of the page's related list's last item, so new items continue that list.
// A marker that already holds content is never moved (its region belongs to an earlier, reviewed change).
export function placeMarkdownMarker(fileContent, markerName, { placeBefore = null, appendToRelatedList = false } = {}) {
  const start = `<!-- SEOAI:${markerName}:START -->`;
  const end = `<!-- SEOAI:${markerName}:END -->`;
  const emptyPair = new RegExp(`[ \\t]*${start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*\\n?`);
  const src = String(fileContent || '');
  if (src.includes(start) && !emptyPair.test(src)) return { content: src, moved: false };
  const without = src.includes(start) ? src.replace(emptyPair, '') : src;
  if (appendToRelatedList) {
    const rel = RELATED_HEADING.exec(without);
    if (!rel) return { content: src, moved: false };
    const lines = without.slice(rel.index + rel[0].length).split('\n');
    let offset = rel.index + rel[0].length; let lastItemEnd = -1;
    for (const line of lines) {
      const lineStart = offset; offset += line.length + 1;
      if (LINK_ITEM.test(line)) lastItemEnd = lineStart + line.length;
      else if (line.trim() && lastItemEnd >= 0) break;
    }
    if (lastItemEnd < 0) return { content: src, moved: false };
    return { content: `${without.slice(0, lastItemEnd)}${start}${end}${without.slice(lastItemEnd)}`, moved: true };
  }
  if (placeBefore) {
    const idx = without.split('\n').findIndex((l) => l.trim() === placeBefore.trim());
    if (idx >= 0) {
      const lines = without.split('\n');
      lines.splice(idx, 0, `${start}${end}`, '');
      return { content: lines.join('\n'), moved: true };
    }
  }
  return { content: src, moved: false };
}

// Loads up to `limit` other Markdown pages from the same folder as `filePath` (cached per site + folder for an hour, so
// a batch of drafts against one blog costs one tree read and a handful of file reads, not one per draft).
const cache = new Map();
export async function loadSiblingMarkdown(site, filePath, { getRepoTree, getFileContent, ref, limit = 8, now = Date.now() } = {}) {
  const dir = String(filePath).split('/').slice(0, -1).join('/');
  const key = `${site?.id}:${ref}:${dir}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < 3600_000) return hit.texts;
  const tree = await getRepoTree(site, ref);
  const candidates = (tree?.files || [])
    .filter((p) => p !== filePath && isMarkdownFile(p) && p.split('/').slice(0, -1).join('/') === dir)
    .slice(0, limit);
  const texts = [];
  for (const p of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const f = await getFileContent(site, p, ref).catch(() => null);
    if (f?.content) texts.push(f.content);
  }
  cache.set(key, { at: now, texts });
  return texts;
}

// Pure. Where a meta-title change may be written in a Markdown page's front matter.
// On most Markdown sites `title:` is ALSO the page's visible headline (and the card title on listings): a title fix
// written there rewrote two blog headlines on 2026-11-23, one into a different topic. The browser/search title belongs
// in the site's own separate field when it has one (`seoTitle:` is the convention these sites use).
//  - an explicitly configured lineKeys.title always wins (a person decided);
//  - the page has `seoTitle:` → write there;
//  - other pages in the collection use `seoTitle:` (so the site supports it) → add one, seeded with the current title;
//  - otherwise refuse: changing the visible headline is not a meta fix.
// Any `# SEOAI:TITLE` marker sitting on `title:` is removed so it can never be written there again.
export function planMarkdownTitleField(fileContent, siblingTexts = [], configuredLineKeys = null) {
  if (configuredLineKeys?.title) return { ok: true, content: fileContent, lineKeys: configuredLineKeys, changed: false };
  const src = String(fileContent || '');
  const fm = /^---\n([\s\S]*?)\n---/.exec(src);
  if (!fm) return { ok: true, content: src, lineKeys: configuredLineKeys, changed: false }; // no front matter: not this case
  const block = fm[1];
  const unmarked = block.replace(/^(title:.*?)[ \t]+#[ \t]*SEOAI:TITLE[ \t]*$/m, '$1');
  const rebuild = (newBlock) => src.replace(fm[0], `---\n${newBlock}\n---`);
  const lineKeys = { ...(configuredLineKeys || {}), title: 'seoTitle' };
  if (/^seoTitle:/m.test(unmarked)) return { ok: true, content: rebuild(unmarked), lineKeys, changed: unmarked !== block };
  const supported = siblingTexts.some((t) => /^---\n[\s\S]*?^seoTitle:[\s\S]*?\n---/m.test(String(t || '')));
  const titleLine = /^title:[ \t]*(.*)$/m.exec(unmarked);
  if (supported && titleLine) {
    const value = titleLine[1].trim().replace(/^(["'])(.*)\1$/, '$2').replace(/"/g, '\\"');
    const withSeo = unmarked.replace(titleLine[0], `${titleLine[0]}\nseoTitle: "${value}"`);
    return { ok: true, content: rebuild(withSeo), lineKeys, changed: true };
  }
  return {
    ok: false, reason: 'title-is-visible-headline',
    error: 'On this site the front-matter title is also the visible headline, and no separate SEO-title field is in use, so the title was not changed. Set a title field for this collection (lineKeys) to allow it.',
  };
}
