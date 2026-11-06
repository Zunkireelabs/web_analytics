// What a generated blog post must satisfy before it can ship — the publishing contract, checked on the output rather
// than hoped for in a prompt.
//
// TENANT-AGNOSTIC BY CONSTRUCTION. Nothing here names a client, a theme, a partial or a class. The required fields and
// length bounds come from the tenant's own configuration:
//
//     url_file_map.newContentTargets['blog-outline'] = {
//       dir: 'src/blog',
//       frontMatter: {
//         required: ['title', 'seoTitle', 'seoDescription', 'description', 'date', 'category', 'tags',
//                    'readTime', 'featuredImage', 'featuredImageAlt', 'translationKey'],
//         lengths: { seoTitle: [30, 60], seoDescription: [110, 160] },
//         allowed: { category: ['Guides', 'News'] },      // optional: a closed vocabulary per field
//         imagePrefix: 'src/assets/images/blog/',          // optional: where images must live
//       },
//       body: { directAnswerWords: [40, 60], requireFaq: true, requireSources: true },
//     }
//
// A tenant that configures none of this gets only the universally safe structural checks (plain markdown, one H1,
// tables with a header row), because inventing a field list for someone who never asked for one would refuse content
// for failing a rule they never set. Every bound is a tenant's own number, so two tenants can disagree.

const UNIVERSAL_BODY_RULES = Object.freeze({
  // A generated post is prose, not layout: a wrapper div or a styled card in the body is the generator reaching past
  // markdown into the tenant's design, which is exactly what the design rules forbid.
  forbiddenMarkup: [
    [/<div\b/i, 'wrapper-div', 'A blog post body is plain markdown — never a <div>. Use headings, paragraphs, lists and tables.'],
    [/<section\b/i, 'wrapper-section', 'A blog post body is plain markdown — never a <section>.'],
    [/\bclass=["']/i, 'inline-class', 'Never set a class in a post body: styling belongs to the site\'s own templates.'],
    [/\bstyle=["']/i, 'inline-style', 'Never set an inline style in a post body.'],
  ],
});

/**
 * Check one generated post against its tenant's contract.
 *
 * post:   { frontMatter: {...}, body: '...' } — or raw markdown, in which case front matter is parsed from it
 * target: the tenant's newContentTargets['blog-outline'] entry (may be undefined)
 *
 * Returns { ok, issues[] } where each issue is { field, code, detail }. Never throws: a malformed post is an issue to
 * report, not an exception for the caller to handle.
 */
export function checkBlogPostContract(post, target = {}) {
  const issues = [];
  const { frontMatter, body } = normalize(post);
  const fmRules = target?.frontMatter || {};
  const bodyRules = target?.body || {};

  // --- front matter: only what the tenant actually requires ---------------
  for (const field of fmRules.required || []) {
    const value = frontMatter[field];
    if (value == null || String(value).trim() === '' || (Array.isArray(value) && !value.length)) {
      issues.push({ field, code: 'missing-front-matter', detail: `Front matter is missing required field "${field}".` });
    }
  }

  for (const [field, bounds] of Object.entries(fmRules.lengths || {})) {
    const value = frontMatter[field];
    if (value == null || String(value).trim() === '') continue; // already reported above if it was required
    const [min, max] = bounds;
    const length = String(value).trim().length;
    if (length < min || length > max) {
      issues.push({
        field, code: 'front-matter-length',
        detail: `"${field}" is ${length} characters; this site requires ${min} to ${max}.`,
      });
    }
  }

  for (const [field, allowed] of Object.entries(fmRules.allowed || {})) {
    const value = frontMatter[field];
    if (value == null || String(value).trim() === '') continue;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (!allowed.includes(v)) {
        issues.push({
          field, code: 'front-matter-not-allowed',
          detail: `"${field}" is "${v}", which is not one of this site's allowed values (${allowed.join(', ')}).`,
        });
      }
    }
  }

  if (fmRules.imagePrefix && frontMatter.featuredImage) {
    const image = String(frontMatter.featuredImage);
    if (!image.startsWith(fmRules.imagePrefix) && !/^https?:\/\//i.test(image)) {
      issues.push({
        field: 'featuredImage', code: 'image-wrong-location',
        detail: `featuredImage is "${image}"; this site keeps post images under ${fmRules.imagePrefix}.`,
      });
    }
  }
  // An image with no alt text is an accessibility defect regardless of configuration.
  if (frontMatter.featuredImage && !String(frontMatter.featuredImageAlt || '').trim()) {
    issues.push({ field: 'featuredImageAlt', code: 'missing-image-alt', detail: 'A featured image needs alt text describing it.' });
  }

  // --- body: universal structure, then the tenant's own shape ------------
  issues.push(...checkBodyStructure(body));

  if (Array.isArray(bodyRules.directAnswerWords)) {
    const [min, max] = bodyRules.directAnswerWords;
    const words = openingAnswerWordCount(body);
    if (words === 0) {
      issues.push({ field: 'body', code: 'missing-direct-answer', detail: `The post must open with a direct answer of ${min} to ${max} words before any heading.` });
    } else if (words < min || words > max) {
      issues.push({ field: 'body', code: 'direct-answer-length', detail: `The opening answer is ${words} words; this site requires ${min} to ${max}.` });
    }
  }

  if (bodyRules.requireFaq && !hasHeadingLike(body, /faq|frequently asked|common questions/i)) {
    issues.push({ field: 'body', code: 'missing-faq', detail: 'This site requires an FAQ section in every post.' });
  }
  if (bodyRules.requireSources && !hasHeadingLike(body, /sources?|references?|further reading/i)) {
    issues.push({ field: 'body', code: 'missing-sources', detail: 'This site requires a Sources list in every post.' });
  }

  return { ok: issues.length === 0, issues };
}

// Structure that is wrong for any tenant: layout markup in a prose body, more than one H1, a table without a header.
function checkBodyStructure(body) {
  const issues = [];
  if (!body || !body.trim()) {
    return [{ field: 'body', code: 'empty-body', detail: 'The post has no body.' }];
  }
  for (const [pattern, code, detail] of UNIVERSAL_BODY_RULES.forbiddenMarkup) {
    if (pattern.test(body)) issues.push({ field: 'body', code, detail });
  }

  const h1Count = (body.match(/^#\s+\S/gm) || []).length + (body.match(/<h1\b/gi) || []).length;
  if (h1Count > 1) {
    issues.push({ field: 'body', code: 'multiple-h1', detail: `The body has ${h1Count} H1 headings; a page has exactly one, and the title supplies it.` });
  }

  for (const table of markdownTables(body)) {
    // A markdown table's second line is its header separator; without it the first row is not a header.
    if (!/^\s*\|?[\s:-]*-{3,}[\s:|-]*\|?\s*$/m.test(table.split('\n')[1] || '')) {
      issues.push({ field: 'body', code: 'table-without-header', detail: 'Every table needs a header row.' });
      break;
    }
  }
  if (/<table\b/i.test(body) && !/<thead\b/i.test(body)) {
    issues.push({ field: 'body', code: 'table-without-header', detail: 'An HTML table needs a <thead>.' });
  }
  return issues;
}

// The words before the first heading: the post's opening answer.
function openingAnswerWordCount(body) {
  if (!body) return 0;
  const beforeFirstHeading = body.split(/^#{1,6}\s/m)[0] || '';
  return beforeFirstHeading
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#*_>`[\]()!-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

function hasHeadingLike(body, pattern) {
  const headings = [...String(body || '').matchAll(/^#{1,6}\s*(.+)$/gm)].map((m) => m[1]);
  return headings.some((h) => pattern.test(h));
}

function markdownTables(body) {
  return [...String(body || '').matchAll(/(^\|.*\|\s*$\n)+/gm)].map((m) => m[0]);
}

// Accepts either a parsed post or raw markdown with YAML front matter. Deliberately a small parser rather than a YAML
// dependency: these are generated files with flat scalar and simple list fields, and a full parser would accept shapes
// the publishing pipeline cannot handle anyway.
export function normalize(post) {
  if (post && typeof post === 'object' && !Array.isArray(post) && (post.frontMatter || post.body)) {
    return { frontMatter: post.frontMatter || {}, body: post.body || '' };
  }
  const raw = String(post ?? '');
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw);
  if (!match) return { frontMatter: {}, body: raw };
  return { frontMatter: parseFrontMatter(match[1]), body: match[2] || '' };
}

function parseFrontMatter(text) {
  const out = {};
  let currentListKey = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && currentListKey) {
      out[currentListKey].push(unquote(listItem[1]));
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, value] = pair;
    if (value === '' || value === '[]') { out[key] = []; currentListKey = key; continue; }
    currentListKey = null;
    if (/^\[.*\]$/.test(value)) {
      out[key] = value.slice(1, -1).split(',').map((v) => unquote(v.trim())).filter(Boolean);
    } else {
      out[key] = unquote(value);
    }
  }
  return out;
}

const unquote = (v) => String(v).replace(/^['"]|['"]$/g, '').trim();

/** One line per issue, for a draft's own failure message. */
export function describeBlogContractIssues(issues) {
  return (issues || []).map((i) => `${i.field}: ${i.detail}`).join(' ');
}
