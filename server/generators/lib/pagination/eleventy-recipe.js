// The Eleventy (Nunjucks) recipe for paginating a blog listing: turns "one page that loops over every post" into Eleventy's own built-in
// pagination (the same mechanism zunkireelabs-web and chayce use): `pagination:` in the front matter, a permalink that gives page 1 the
// listing URL and later pages /<listing>/page/<n>/, per-page titles and descriptions, a loop over the page's slice, and a pager.
//
// Pure: source text in, new source text out. It only acts when it can do so safely and REFUSES, with a specific reason, everything else.
// The refusals matter as much as the transform. Of the four Eleventy clients checked on 2026-11-21: two already paginate, one (mobilise) is a
// hand-written list of cards with JSON front matter and no loop at all, one (zennly) paginates with JavaScript. None of those is touched.
//
// Preconditions (any miss is a refusal):
//   - YAML front matter at the top of the file (---), not JSON front matter
//   - no `pagination:` already
//   - the posts come from `{% for x in collections.NAME %}` (optionally `| reverse`): one visible loop, plus any number of loops over the same
//     collection inside <script> (a JSON-LD list), which are paginated with it
//   - a plain-text `title` (the page needs a unique title per page); `description` too when present
//   - title/description lines carry no SEOAI marker (the setup automation edits those lines in place; moving their value into a computed
//     field would silently turn that automation off for this page)
//   - `eleventyComputed` (when present) does not already define title or description
export const ELEVENTY_ALIAS = 'pagedPosts';
export const DEFAULT_PAGE_SIZE = 12;

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
const refuse = (reason, error) => ({ ok: false, reason, error });
const yamlEsc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const UNSAFE = /\{\{|\{%|#\s*SEOAI/;

// The value of a top-level `key:` line when it is a plain one-line string; null when absent; { unsafe } when it is anything else.
function plainScalar(fm, key) {
  const line = new RegExp(`^${key}[ \\t]*:[ \\t]*(.*)$`, 'm').exec(fm);
  if (!line) return null;
  const raw = line[1].trim();
  if (!raw || /^[>|]/.test(raw) || UNSAFE.test(line[0])) return { unsafe: true };
  const quoted = /^"((?:[^"\\]|\\.)*)"\s*$/.exec(raw);
  if (quoted) return { value: quoted[1].replace(/\\(["\\])/g, '$1') };
  const single = /^'((?:[^']|'')*)'\s*$/.exec(raw);
  if (single) return { value: single[1].replace(/''/g, "'") };
  if (/^["']/.test(raw)) return { unsafe: true };
  return { value: raw };
}

// Index just past the `{% endfor %}` that closes the for-loop starting at `from` (the end of its opening tag).
function matchingEndfor(body, from) {
  const tags = /\{%-?\s*(for|endfor)\b[^%]*-?%\}/g;
  tags.lastIndex = from;
  for (let depth = 1, m; (m = tags.exec(body));) {
    depth += m[1] === 'for' ? 1 : -1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

function pagerMarkup(buttonClass, currentClass = buttonClass) {
  const cls = buttonClass ? ` class="${buttonClass}"` : '';
  const cur = currentClass ? ` class="${currentClass}"` : '';
  return [
    '{% if pagination.pages.length > 1 %}',
    '<nav class="blog-pager" aria-label="Blog pages">',
    `  {% if pagination.href.previous %}<a${cls} href="{{ pagination.href.previous }}" rel="prev">Newer posts</a>{% endif %}`,
    '  {% for pagerPage in pagination.pages %}',
    `    {% if loop.index0 == pagination.pageNumber %}<span${cur} aria-current="page">{{ loop.index }}</span>{% else %}<a${cls} href="{{ pagination.hrefs[loop.index0] }}">{{ loop.index }}</a>{% endif %}`,
    '  {% endfor %}',
    `  {% if pagination.href.next %}<a${cls} href="{{ pagination.href.next }}" rel="next">Older posts</a>{% endif %}`,
    '  <p class="blog-pager-count">Page {{ pagination.pageNumber + 1 }} of {{ pagination.pages.length }}</p>',
    '</nav>',
    '{% endif %}',
  ].join('\n');
}

/**
 * @param {{ source: string, basePath: string, pageSize?: number, buttonClass?: string|null, currentClass?: string|null }} p
 *   basePath: the listing's path, e.g. "/blog/" (page 1 keeps it; later pages go to <basePath>page/<n>/)
 *   buttonClass / currentClass: the SITE'S OWN button classes (from its design profile) for the pager links and for the current page's
 *   button; never another client's. currentClass defaults to buttonClass.
 * @returns {{ ok: true, after: string, notes: string[] } | { ok: false, reason: string, error: string }}
 */
export function planEleventyPagination({ source, basePath, pageSize = DEFAULT_PAGE_SIZE, buttonClass = null, currentClass = null }) {
  const text = String(source ?? '');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const m = FRONT_MATTER.exec(text);
  if (!m) return refuse('no-yaml-front-matter', 'The listing has no YAML front matter (---) at its start. It may use JSON front matter or be a plain include, which this recipe does not rewrite.');
  let fm = m[1];
  let body = text.slice(m[0].length);
  if (/^\s*[{[]/.test(fm)) return refuse('json-front-matter', 'The listing uses JSON front matter, which this recipe does not rewrite.');
  if (/^pagination\s*:/m.test(fm)) return refuse('already-paginated', 'The listing already has pagination: in its front matter. Nothing to do.');
  if (new RegExp(`\\b${ELEVENTY_ALIAS}\\b`).test(text)) return refuse('alias-in-use', `The listing already uses the name "${ELEVENTY_ALIAS}", which this recipe needs for the page's posts.`);

  const loops = [...body.matchAll(/\{%-?\s*for\s+(\w+)\s+in\s+(collections\.[A-Za-z0-9_]+)([^%]*?)-?%\}/g)];
  if (!loops.length) return refuse('no-collection-loop', 'The listing has no {% for post in collections.<name> %} loop, so its posts come from somewhere this recipe cannot paginate (a hand-written list, a data file, or an already-sliced alias).');
  // A listing often loops over its posts twice: once for the visible cards and once inside a <script> for its JSON-LD ItemList. Both must
  // show the SAME slice, so every loop over the same collection is paginated; the pager goes after the one visible loop.
  const collection = loops[0][2];
  const tail = loops[0][3];
  if (loops.some((l) => l[2] !== collection || l[3].trim() !== tail.trim())) return refuse('several-collection-loops', 'The listing loops over more than one collection (or the same one with different filters), so it is not clear which posts it lists.');
  const filters = tail.trim();
  if (filters && !/^\|\s*reverse$/.test(filters)) return refuse('loop-filters', `The loop applies a filter (${filters}) that pagination cannot carry over.`);
  const reverse = Boolean(filters);
  const scriptRanges = [...body.matchAll(/<script\b[\s\S]*?<\/script>/gi)].map((r) => [r.index, r.index + r[0].length]);
  const inScript = (i) => scriptRanges.some(([a, b]) => i >= a && i < b);
  const visible = loops.filter((l) => !inScript(l.index));
  if (!visible.length) return refuse('no-visible-loop', 'Every loop over the posts is inside a <script>, so no visible list of posts was found to paginate.');
  if (visible.length > 1) return refuse('several-listing-loops', 'The listing shows its posts in more than one place, so it is not clear where the pager belongs.');
  const loop = visible[0];
  const loopEnd = loop.index + loop[0].length;
  const endforAt = matchingEndfor(body, loopEnd);
  if (endforAt < 0) return refuse('unbalanced-loop', 'The loop over the posts has no matching {% endfor %}.');

  const title = plainScalar(fm, 'title');
  if (!title) return refuse('no-title', 'The listing has no title in its front matter, so a unique title for each page cannot be made.');
  if (title.unsafe) return refuse('title-not-plain', 'The listing title is not a plain one-line string (it uses template syntax, a block scalar or an SEOAI marker), so it cannot be varied per page without breaking what edits it.');
  const description = plainScalar(fm, 'description');
  if (description?.unsafe) return refuse('description-not-plain', 'The listing description is not a plain one-line string (it uses template syntax, a block scalar or an SEOAI marker).');

  const base = basePath.endsWith('/') ? basePath : `${basePath}/`;
  const noSlash = base.replace(/\/$/, '') || '/';
  const permalink = `permalink: "{% if pagination.pageNumber == 0 %}${yamlEsc(base)}{% else %}${yamlEsc(noSlash)}/page/{{ pagination.pageNumber + 1 }}/{% endif %}"`;
  const paginationBlock = [`pagination:`, `  data: ${collection}`, `  size: ${pageSize}`, ...(reverse ? ['  reverse: true'] : []), `  alias: ${ELEVENTY_ALIAS}`].join(eol);

  // Per-page title and description. They go in eleventyComputed because that is the only place a front-matter value can depend on the page
  // number; page 1 keeps the exact original text.
  const [head, brand] = (() => { const i = title.value.lastIndexOf(' | '); return i > 0 ? [title.value.slice(0, i), title.value.slice(i + 3)] : [title.value, null]; })();
  const pageTitle = `${head}, Page {{ pagination.pageNumber + 1 }}${brand ? ` | ${brand}` : ''}`;
  const computed = [
    `  title: "{% if pagination.pageNumber == 0 %}${yamlEsc(title.value)}{% else %}${yamlEsc(pageTitle)}{% endif %}"`,
    ...(description ? [`  description: "{% if pagination.pageNumber == 0 %}${yamlEsc(description.value)}{% else %}${yamlEsc(description.value)} (Page {{ pagination.pageNumber + 1 }}){% endif %}"`] : []),
  ];
  const existing = /^eleventyComputed[ \t]*:[ \t]*$/m.exec(fm);
  if (existing) {
    const rest = fm.slice(existing.index + existing[0].length);
    const block = /^(?:[ \t]+.*|)(?:\r?\n(?:[ \t]+.*|))*/.exec(rest)?.[0] ?? '';
    if (/^[ \t]+(title|description)[ \t]*:/m.test(block)) return refuse('computed-title', 'eleventyComputed already defines the title or description, so it cannot be extended safely.');
    fm = fm.slice(0, existing.index + existing[0].length) + eol + computed.join(eol) + fm.slice(existing.index + existing[0].length);
  } else if (/^eleventyComputed[ \t]*:/m.test(fm)) {
    return refuse('computed-not-a-block', 'eleventyComputed is written in a form this recipe does not extend.');
  } else {
    fm = `${fm}${eol}eleventyComputed:${eol}${computed.join(eol)}`;
  }
  fm = fm.replace(/^permalink[ \t]*:.*(\r?\n|$)/m, '');         // replaced by the paginated permalink below
  fm = fm.replace(/(\r?\n)+$/, '');
  fm = `${fm}${eol}${paginationBlock}${eol}${permalink}`;

  // Edit from the end of the file backwards so earlier positions stay valid: the pager first (it sits after the visible loop), then headers.
  body = body.slice(0, endforAt) + eol + pagerMarkup(buttonClass, currentClass || buttonClass) + body.slice(endforAt);
  for (const l of [...loops].sort((a, b) => b.index - a.index)) {
    body = body.slice(0, l.index) + l[0].replace(collection + l[3].trimEnd(), ELEVENTY_ALIAS) + body.slice(l.index + l[0].length);
  }
  const after = `---${eol}${fm}${eol}---${eol}${body}`;

  const notes = [
    `Paginates ${collection} at ${pageSize} per page, with Eleventy's own pagination (the posts of a page are in "${ELEVENTY_ALIAS}").`,
    `Page 1 stays at ${base}; later pages are ${noSlash}/page/<n>/.`,
    buttonClass ? `The pager reuses this site's own button classes: ${buttonClass}.` : 'No button classes were available from the site\'s design profile, so the pager links are unstyled: style .blog-pager to match the site before merging.',
    'The pager marks the current page with aria-current="page"; give that state a visible style in the site\'s own CSS if its buttons have none.',
    'Check the site\'s layout uses page.url for its canonical tag: a canonical fixed to the listing URL would point every page at page 1.',
    'Eleventy leaves pages 2 and up out of collections, so a sitemap built from collections will not list them. That is harmless (they are linked from the pager); list them if you want them in the sitemap.',
  ];
  return { ok: true, after, notes };
}
