// IS THIS CHANGE VISIBLE? Every change a generator makes is classified before anything is judged. A change is VISIBLE when it changes what a visitor
// sees (a blog, a new page, a FAQ section, expanded content, a table, a related-links list, breadcrumbs, a headline or title, an image) and then it must
// pass the strict design protection. It is NOT VISIBLE only when it is CONFIRMED not to touch rendered output (a meta description, JSON-LD alone, robots,
// a sitemap). Recorded lesson: the check is a DENY-list of confirmed no-markup generators, never an allow-list of design-affecting ones, so a new or
// unknown generator is judged by default instead of slipping through.
//
// Two independent signals; the stricter wins:
//   1. the generator (and the action it performs), and
//   2. what the files actually change: stripping the head, JSON-LD, comments and non-visible front matter from before and after, does the page differ?
// A "not visible" generator whose files DO change visible content is visible (a schema generator that adds a visible FAQ is a FAQ).

export const CONFIRMED_NOT_VISIBLE = new Set([
  'meta-description', 'robots', 'robots-txt', 'sitemap', 'llms-txt', 'schema', 'schema-repair', 'canonical', 'redirect', 'redirects', 'hreflang',
  'alt-text', 'viewport', 'analytics-install', 'indexnow', 'og-tags', 'twitter-tags', 'nginx-headers', 'security-headers',
]);

// What kind of visible change each generator makes. 'format' kinds must copy a pattern the site already has (faq, table, related-links, breadcrumbs).
export const VISIBLE_KINDS = Object.freeze({
  'blog-outline': 'article', 'new-page': 'page', 'landing-page': 'page', 'service-page': 'page', 'location-page': 'page', 'comparison-page': 'page',
  faq: 'faq', 'qa-content': 'faq', 'direct-answer': 'prose', 'expand-content': 'prose', 'refresh-content': 'prose', 'internal-links': 'related-links',
  breadcrumbs: 'breadcrumbs', 'blog-image': 'image', 'meta-title': 'headline', table: 'table', 'comparison-table': 'table',
});

// Kinds that are a FORMAT: the page must already show one of these somewhere on the template, or the agent would be inventing a design.
export const FORMAT_KINDS = new Set(['faq', 'table', 'related-links', 'breadcrumbs']);

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
// Front matter keys that never render in the page body or as its headline.
const HIDDEN_KEYS = /^(description|metadescription|seodescription|seotitle|metatitle|canonical|robots|keywords|og[:_-]?\w*|twitter[:_-]?\w*|schema|jsonld|permalink|layout|date|updated|lastmod|tags|lang|locale)$/i;

/** Pure. The part of a source file a visitor can see: no head, no JSON-LD, no comments, no hidden front matter. Whitespace-normalised. */
export function visiblePart(source) {
  let s = String(source ?? '');
  const fm = s.match(FRONT_MATTER);
  let front = '';
  if (fm) {
    s = s.slice(fm[0].length);
    front = fm[1].split(/\r?\n/).filter((line) => { const k = line.split(':')[0].trim().replace(/[-_ ]/g, ''); return k && !HIDDEN_KEYS.test(k); }).join('\n');
  }
  s = s.replace(/<head[\s>][\s\S]*?<\/head>/gi, '')
    .replace(/<script[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<!--(?!\s*SEOAI:)[\s\S]*?-->/g, '');
  return `${front}\n${s}`.replace(/\s+/g, ' ').trim();
}

/** Pure. Does any file's visible part differ between before and after? A new file (no before) is visible unless it is empty after stripping. */
export function filesChangeVisibleOutput(files = []) {
  const changed = [];
  for (const f of files) {
    const before = visiblePart(f.before ?? '');
    const after = visiblePart(f.after ?? f.content ?? '');
    if (before !== after) changed.push(f.path || '(unnamed)');
  }
  return changed;
}

/**
 * Pure. Classify one change.
 *   generatorId   the generator / action type ('faq', 'schema', 'meta-title', 'blog-outline', ...)
 *   files         [{ path, before, after }]  optional; when given, the files are inspected too
 *   titleIsHeadline  for a title change: true (default) when the page's visible headline IS the title being changed
 * @returns {{visible:boolean, kind:string|null, format:boolean, source:string, reasons:string[], changedFiles:string[]}}
 */
export function classifyChange({ generatorId, files = null, titleIsHeadline = true } = {}) {
  const id = String(generatorId || '').toLowerCase();
  const reasons = [];
  const kind = VISIBLE_KINDS[id] || null;
  const confirmedHidden = CONFIRMED_NOT_VISIBLE.has(id);
  const changedFiles = files ? filesChangeVisibleOutput(files) : [];

  let visible;
  let source;
  if (id === 'meta-title') {
    visible = titleIsHeadline !== false;
    source = 'generator';
    reasons.push(visible ? 'the page headline is the title being changed (no separate SEO-title field)' : 'a separate SEO-title field is changed, not the headline');
  } else if (confirmedHidden) {
    visible = false; source = 'generator'; reasons.push(`"${id}" is confirmed to emit no visible markup`);
  } else if (kind) {
    visible = true; source = 'generator'; reasons.push(`"${id}" writes visible content (${kind})`);
  } else {
    visible = true; source = 'unknown-default'; reasons.push(`"${id || 'unknown'}" is not confirmed as emitting no markup, so it is judged`);
  }
  // The stricter signal wins: files that change visible output make a "not visible" change visible.
  if (!visible && files && changedFiles.length) {
    visible = true; source = 'content'; reasons.push(`its files change visible output (${changedFiles.slice(0, 3).join(', ')})`);
  }
  return { visible, kind: visible ? (kind || 'prose') : null, format: visible && FORMAT_KINDS.has(kind), source, reasons, changedFiles };
}

/** Pure. Does this set of changed paths include a file shared by many pages (a layout, partial, include, component, stylesheet, theme)? */
export function touchesSharedFiles(paths = []) {
  const shared = /(^|\/)(_includes|_layouts|layouts?|partials?|components?|templates?|snippets?|theme|styles?|css|scss|sass|public\/css|assets\/css)(\/|$)|\.(css|scss|sass|less)$|(^|\/)(tailwind|postcss)\.config\./i;
  return paths.filter((p) => shared.test(String(p || '')));
}
