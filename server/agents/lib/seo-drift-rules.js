// Compares a page's current snapshot with its baseline and returns what changed, by severity.
//
// The rules and thresholds follow claude-seo's seo-drift skill (MIT, (c) 2026 agricidaniel; skill by Dan Colta): schema removed,
// canonical changed/removed, noindex added, H1 removed/changed, title removed, page now an error, title/description/schema changed,
// social tags removed, schema added, H2s changed, content changed. Not ported: its two Core Web Vitals rules (11, 12), because
// snapshots here carry no performance data; those would need the PageSpeed ingest wired in. Differences from the original:
//  - "H1 changed significantly" uses a bigram (Dice) similarity, not Python's SequenceMatcher. Both are 0..1 and the same 0.5
//    cut-off is used, but they are different measures, so edge cases can differ.
//  - the content rule compares a hash of normalized visible text (lib/seo-snapshot.js), not of raw HTML.
//
// Severity says how urgent a change is, not whether it is wrong:
//   critical  a change that can remove the page from search or its rich results within days
//   warning   may move rankings or click-through; often intentional, so a person should look
//   info      recorded for the history, never raised to the Action Center (too often a normal edit)
// Pure: two snapshots in, findings out.

export const SEVERITY = { CRITICAL: 'critical', WARNING: 'warning', INFO: 'info' };
export const H1_SIMILARITY_FLOOR = 0.5;

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const has = (v) => Array.isArray(v) ? v.length > 0 : v != null && String(v).trim() !== '';

// 0..1, how alike two strings are, by shared character pairs (Dice coefficient). Case-insensitive.
export function similarity(a, b) {
  const x = norm(a).toLowerCase(); const y = norm(b).toLowerCase();
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const pairs = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i += 1) { const p = s.slice(i, i + 2); m.set(p, (m.get(p) || 0) + 1); } return m; };
  const px = pairs(x); const py = pairs(y);
  let shared = 0;
  for (const [p, n] of px) shared += Math.min(n, py.get(p) || 0);
  return (2 * shared) / (x.length - 1 + y.length - 1);
}

const directives = (robots) => new Set(String(robots || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean));
const isOk = (code) => code >= 200 && code < 300;
const f = (rule, severity, what, was, now, message) => ({ rule, severity, what, was: was ?? null, now: now ?? null, message });

const RULES = [
  // ── critical
  (b, c) => (has(b.schemaHash) && !has(c.schemaHash)
    ? f('schema-removed', SEVERITY.CRITICAL, 'Structured data', (b.schemaTypes || []).join(', ') || 'present', null, 'All structured data was removed. Rich results can drop out of search within days.') : null),
  (b, c) => (has(b.canonical) && has(c.canonical) && b.canonical !== c.canonical
    ? f('canonical-changed', SEVERITY.CRITICAL, 'Canonical URL', b.canonical, c.canonical, 'The canonical URL changed. A wrong one sends this page\'s ranking signals to a different page.') : null),
  (b, c) => (has(b.canonical) && !has(c.canonical)
    ? f('canonical-removed', SEVERITY.CRITICAL, 'Canonical URL', b.canonical, null, 'The canonical URL was removed. Google will pick one itself, often the wrong one.') : null),
  (b, c) => (!directives(b.robots).has('noindex') && directives(c.robots).has('noindex')
    ? f('noindex-added', SEVERITY.CRITICAL, 'Search visibility', b.robots, c.robots, 'The page now tells search engines not to index it. It will drop out of Google within days.') : null),
  (b, c) => (has(b.h1) && !has(c.h1)
    ? f('h1-removed', SEVERITY.CRITICAL, 'Main heading (H1)', b.h1[0], null, 'The main heading was removed. It is the clearest signal of what the page is about.') : null),
  (b, c) => (has(b.h1) && has(c.h1) && similarity(b.h1[0], c.h1[0]) < H1_SIMILARITY_FLOOR
    ? f('h1-rewritten', SEVERITY.CRITICAL, 'Main heading (H1)', b.h1[0], c.h1[0], 'The main heading was largely rewritten. Check it still matches what the page should rank for.') : null),
  (b, c) => (has(b.title) && !has(c.title)
    ? f('title-removed', SEVERITY.CRITICAL, 'Page title', b.title, null, 'The page title was removed. Google will write one itself, usually badly.') : null),
  (b, c) => (isOk(b.statusCode) && c.statusCode >= 400
    ? f('page-error', SEVERITY.CRITICAL, 'Page status', String(b.statusCode), String(c.statusCode), `The page used to load normally and now returns an error (${c.statusCode}). It will lose its rankings if this continues.`) : null),

  // ── warning
  (b, c) => (has(b.title) && has(c.title) && norm(b.title) !== norm(c.title)
    ? f('title-changed', SEVERITY.WARNING, 'Page title', b.title, c.title, 'The page title changed. Check it still has the target keywords, and watch click-through for two weeks.') : null),
  (b, c) => (has(b.metaDescription) && norm(b.metaDescription) !== norm(c.metaDescription)
    ? f('description-changed', SEVERITY.WARNING, 'Meta description', b.metaDescription, c.metaDescription, has(c.metaDescription) ? 'The meta description changed. Check it still invites the click.' : 'The meta description was removed. Google will pick text from the page instead.') : null),
  (b, c) => (Object.keys(b.openGraph || {}).length > 0 && Object.keys(c.openGraph || {}).length === 0
    ? f('social-tags-removed', SEVERITY.WARNING, 'Social sharing tags', Object.keys(b.openGraph).join(', '), null, 'The social sharing tags were removed. Shared links will show a generic or empty preview.') : null),
  (b, c) => (has(b.schemaHash) && has(c.schemaHash) && b.schemaHash !== c.schemaHash
    ? f('schema-modified', SEVERITY.WARNING, 'Structured data', (b.schemaTypes || []).join(', '), (c.schemaTypes || []).join(', '), 'The structured data was edited. Check it is still valid and no properties were lost.') : null),

  // ── info (kept for the history, never raised)
  (b, c) => (!has(b.schemaHash) && has(c.schemaHash)
    ? f('schema-added', SEVERITY.INFO, 'Structured data', null, (c.schemaTypes || []).join(', ') || 'present', 'Structured data was added.') : null),
  (b, c) => (JSON.stringify(b.h2 || []) !== JSON.stringify(c.h2 || [])
    ? f('subheadings-changed', SEVERITY.INFO, 'Subheadings (H2)', `${(b.h2 || []).length} headings`, `${(c.h2 || []).length} headings`, 'The page\'s subheadings changed.') : null),
  (b, c) => (has(b.contentHash) && has(c.contentHash) && b.contentHash !== c.contentHash
    ? f('content-changed', SEVERITY.INFO, 'Page text', `${b.wordCount ?? '?'} words`, `${c.wordCount ?? '?'} words`, 'The page text changed.') : null),
];

const ORDER = { critical: 0, warning: 1, info: 2 };

/** @returns findings, most severe first. Empty when nothing differs. */
export function compareSnapshots(baseline, current) {
  if (!baseline || !current) return [];
  return RULES.map((rule) => rule(baseline, current)).filter(Boolean).sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}

export const RULE_COUNT = RULES.length;
