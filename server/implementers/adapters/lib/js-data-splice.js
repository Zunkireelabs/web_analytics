// Shared, string/comment-aware splice mechanism for editing ONE entry
// inside a shared array-of-objects content file (e.g. an Eleventy
// `export default [...]` JS data file, or a plain JSON array file) — the
// data-driven counterpart to lib/marker-merge.js's HTML-comment marker
// splice, used when the real per-item content lives in a structured array,
// not a per-page template file (see adapters/data-array-content.js).
//
// `format` is always explicit config, never sniffed from file content (see
// adapters/data-array-content.js) — currently 'js-export-array' (today's
// real, tested case: `export default [...]`) and 'json-array' (a bare
// `[...]` file). Adding a third format later means adding its bounds/
// validation/serialization handling here without touching callers' shapes.
//
// Every bracket scan here treats string literals ("...", '...', `...`) and
// comments (// and /* */) as opaque — a naive char-by-char bracket counter
// would mis-locate an edit boundary the moment any field's text contains a
// literal [, ], {, or } character (a real risk in these files: prose
// descriptions, comparison copy). Getting this right matters more than
// usual here — these are SHARED files imported by every page's build, so a
// misplaced edit doesn't just corrupt one page.

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Scans forward from `start` (the position just after an already-consumed
// opening bracket), returning the index of the matching closing bracket —
// or -1 if content ends before the brackets balance. String/comment content
// never affects depth. Comments never occur in real JSON, but scanning for
// them here anyway is harmless (JSON strings only ever use double quotes,
// which this already handles) — one implementation serves both formats.
export function scanBalanced(content, start, openChar, closeChar) {
  let depth = 1;
  let i = start;
  while (i < content.length) {
    const c = content[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < content.length && content[i] !== quote) {
        if (content[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '/' && content[i + 1] === '/') {
      const nl = content.indexOf('\n', i);
      i = nl === -1 ? content.length : nl + 1;
      continue;
    }
    if (c === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2);
      i = end === -1 ? content.length : end + 2;
      continue;
    }
    if (c === openChar) { depth++; i++; continue; }
    if (c === closeChar) {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

// Where the file's root array begins, per format — 'js-export-array' looks
// for `export default [`, 'json-array' expects the array to open the file
// (optionally after leading whitespace). Unrecognized format -> null,
// never a guessed fallback.
const ROOT_ARRAY_PATTERN_BY_FORMAT = {
  'js-export-array': /export\s+default\s*\[/,
  'json-array': /^\s*\[/,
};

function findRootArrayBounds(content, format) {
  const pattern = ROOT_ARRAY_PATTERN_BY_FORMAT[format];
  if (!pattern) return null;
  const m = pattern.exec(content);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = scanBalanced(content, start, '[', ']');
  if (end === -1) return null;
  return { start, end };
}

// JSON requires quoted keys; js-export-array's real files (checked
// directly against zunkireelabs-web's) use unquoted keys. Matching the
// right shape per format avoids either under- or over-matching.
function keyRegexSource(field, format) {
  const escaped = escapeRegExp(field);
  return format === 'json-array' ? `"${escaped}"\\s*:` : `${escaped}\\s*:`;
}

// Every top-level `{ ... }` object directly inside the file's root array —
// string/comment-aware, so a nested object never gets mistaken for a
// top-level one.
function listTopLevelObjects(content, arrayStart, arrayEnd) {
  const objects = [];
  let i = arrayStart;
  while (i < arrayEnd) {
    const c = content[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === ',') { i++; continue; }
    if (c === '/' && content[i + 1] === '/') {
      const nl = content.indexOf('\n', i);
      i = nl === -1 ? arrayEnd : nl + 1;
      continue;
    }
    if (c === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2);
      i = end === -1 ? arrayEnd : end + 2;
      continue;
    }
    if (c === '{') {
      const close = scanBalanced(content, i + 1, '{', '}');
      if (close === -1 || close > arrayEnd) break;
      objects.push({ start: i, end: close });
      i = close + 1;
      continue;
    }
    break; // unexpected top-level token — bail rather than guess
  }
  return objects;
}

// Locates the ONE top-level object in the file's root array whose
// `idField: idValue` matches — zero or more-than-one matches return null
// rather than a guess. Returns { start, end } — indices of the object's
// own '{' and '}'.
export function findObjectRange(content, idField, idValue, format = 'js-export-array') {
  const bounds = findRootArrayBounds(content, format);
  if (!bounds) return null;
  const objects = listTopLevelObjects(content, bounds.start, bounds.end);
  const idRe = new RegExp(`${keyRegexSource(idField, format)}\\s*["']${escapeRegExp(idValue)}["']`);
  const matches = objects.filter((o) => idRe.test(content.slice(o.start, o.end + 1)));
  return matches.length === 1 ? matches[0] : null;
}

// Returns the byte offset (relative to the whole file) of `key: [` ONLY if
// it appears as a direct property of the object at `objRange` — not nested
// inside some other field's own object/array — or -1 if absent/nested.
function findTopLevelArrayKeyStart(content, objRange, fieldName, format) {
  const keyRe = new RegExp(`${keyRegexSource(fieldName, format)}\\s*\\[`, 'g');
  keyRe.lastIndex = objRange.start + 1;
  let m;
  while ((m = keyRe.exec(content)) && m.index < objRange.end) {
    let depth = 0;
    let i = objRange.start + 1;
    while (i < m.index) {
      const c = content[i];
      if (c === '"' || c === "'" || c === '`') {
        const quote = c;
        i++;
        while (i < content.length && content[i] !== quote) { if (content[i] === '\\') i++; i++; }
        i++;
        continue;
      }
      if (c === '/' && content[i + 1] === '/') { const nl = content.indexOf('\n', i); i = nl === -1 ? content.length : nl + 1; continue; }
      if (c === '/' && content[i + 1] === '*') { const e = content.indexOf('*/', i + 2); i = e === -1 ? content.length : e + 2; continue; }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
      i++;
    }
    if (depth === 0) return m.index;
    keyRe.lastIndex = m.index + 1;
  }
  return -1;
}

// The interior range (excluding brackets) of an EXISTING `fieldName: [...]`
// array directly inside the given object — null if the field doesn't exist
// yet at all (a brand-new field, see insertNewArrayField below).
export function findArrayFieldRange(content, objRange, fieldName, format = 'js-export-array') {
  const keyStart = findTopLevelArrayKeyStart(content, objRange, fieldName, format);
  if (keyStart === -1) return null;
  const bracketIdx = content.indexOf('[', keyStart);
  const start = bracketIdx + 1;
  const end = scanBalanced(content, start, '[', ']');
  if (end === -1) return null;
  return { start, end };
}

// ---- js-export-array: comment-marker-based splice (today's real, tested mechanism) ----

const MARKER_START = '/* SEOAI:FAQ:START */';
const MARKER_END = '/* SEOAI:FAQ:END */';

function renderItemsAsJsObjectLiterals(items, indent) {
  return items.map((qa) => `${indent}{ question: ${JSON.stringify(qa.question)}, answer: ${JSON.stringify(qa.answer)} },`).join('\n');
}

function spliceMarkedArrayComment(content, arrayRange, items) {
  const itemsSource = renderItemsAsJsObjectLiterals(items, '      ');
  const interior = content.slice(arrayRange.start, arrayRange.end);
  if (interior.includes(MARKER_START)) {
    const blockRe = new RegExp(`${escapeRegExp(MARKER_START)}[\\s\\S]*?${escapeRegExp(MARKER_END)}`);
    const replacement = `${MARKER_START}\n${itemsSource}\n      ${MARKER_END}`;
    const newInterior = interior.replace(blockRe, replacement);
    return content.slice(0, arrayRange.start) + newInterior + content.slice(arrayRange.end);
  }
  const trimmed = interior.replace(/\s+$/, '');
  const needsComma = trimmed.length > 0 && !trimmed.endsWith(',');
  const insertPoint = arrayRange.start + trimmed.length;
  const insertion = `${needsComma ? ',' : ''}\n      ${MARKER_START}\n${itemsSource}\n      ${MARKER_END}\n    `;
  return content.slice(0, insertPoint) + insertion + content.slice(arrayRange.end);
}

function insertNewArrayFieldComment(content, objRange, fieldName, items) {
  const itemsSource = renderItemsAsJsObjectLiterals(items, '      ');
  const interior = content.slice(objRange.start + 1, objRange.end);
  const trimmed = interior.replace(/\s+$/, '');
  const needsComma = trimmed.length > 0 && !trimmed.endsWith(',');
  const insertPoint = objRange.start + 1 + trimmed.length;
  const arrayBody = `      ${MARKER_START}\n${itemsSource}\n      ${MARKER_END}`;
  const insertion = `${needsComma ? ',' : ''}\n    ${fieldName}: [\n${arrayBody}\n    ]\n  `;
  return content.slice(0, insertPoint) + insertion + content.slice(objRange.end);
}

function parseManagedFaqItemsComment(arrayInterior) {
  const m = new RegExp(`${escapeRegExp(MARKER_START)}([\\s\\S]*?)${escapeRegExp(MARKER_END)}`).exec(arrayInterior);
  return m ? parseExistingFaqItems(m[1], 'js-export-array') : [];
}

// ---- json-array: sentinel-field-based splice (JSON has no comment syntax to anchor on) ----
//
// Real, honest tradeoff of pure JSON: without comments, there's no way to
// mark "this is the AI-managed region" inline while preserving hand-authored
// items' exact original formatting. Instead, AI-managed items carry a
// `_aiManaged: true` field; re-applying filters out prior `_aiManaged`
// items and appends the new set, then re-serializes the WHOLE items array
// (hand-authored items included) — meaning hand-authored items keep their
// DATA exactly, but the array's raw text formatting is regenerated, not
// byte-preserved, unlike the js-export-array path. Any template consuming
// this JSON that only reads `question`/`answer` fields ignores the extra
// sentinel field harmlessly.

function spliceMarkedArrayJson(content, arrayRange, newAiItems, indent) {
  const interior = content.slice(arrayRange.start, arrayRange.end);
  const existing = JSON.parse(`[${interior}]`);
  const handAuthored = existing.filter((it) => !it._aiManaged);
  const merged = [...handAuthored, ...newAiItems.map((it) => ({ ...it, _aiManaged: true }))];
  const body = merged.map((it) => `${indent}${JSON.stringify(it)}`).join(',\n');
  return content.slice(0, arrayRange.start) + `\n${body}\n${indent.slice(2)}` + content.slice(arrayRange.end);
}

function insertNewArrayFieldJson(content, objRange, fieldName, newAiItems, indent) {
  const interior = content.slice(objRange.start + 1, objRange.end);
  const trimmed = interior.replace(/\s+$/, '');
  const needsComma = trimmed.length > 0 && !trimmed.endsWith(',');
  const insertPoint = objRange.start + 1 + trimmed.length;
  const body = newAiItems.map((it) => `${indent}${JSON.stringify({ ...it, _aiManaged: true })}`).join(',\n');
  const insertion = `${needsComma ? ',' : ''}\n  "${fieldName}": [\n${body}\n  ]\n`;
  return content.slice(0, insertPoint) + insertion + content.slice(objRange.end);
}

function parseManagedFaqItemsJson(arrayInterior) {
  try {
    const items = JSON.parse(`[${arrayInterior}]`);
    return items.filter((it) => it && it._aiManaged && typeof it.question === 'string' && typeof it.answer === 'string');
  } catch {
    return [];
  }
}

// ---- format dispatch ----

// Idempotent splice into an already-existing array's interior: updates the
// AI-managed region in place if present, otherwise appends. Hand-authored
// entries are never removed or reordered by data, in either format (see
// json-array's own comment above for its formatting caveat).
export function spliceMarkedArray(content, arrayRange, items, format = 'js-export-array') {
  if (format === 'json-array') return spliceMarkedArrayJson(content, arrayRange, items, '    ');
  return spliceMarkedArrayComment(content, arrayRange, items);
}

// Inserts a brand-new `fieldName: [...]` property as the object's last
// field — comma-safe relative to whatever field currently comes last. Use
// only when findArrayFieldRange returned null (the field genuinely doesn't
// exist yet); once created, later drafts go through findArrayFieldRange +
// spliceMarkedArray instead.
export function insertNewArrayField(content, objRange, fieldName, items, format = 'js-export-array') {
  if (format === 'json-array') return insertNewArrayFieldJson(content, objRange, fieldName, items, '    ');
  return insertNewArrayFieldComment(content, objRange, fieldName, items);
}

// Hard safety net: this always targets a SHARED file imported by every
// entry's page build, not one page's own template — a syntax error here
// fails the entire site build, not just one page.
export function assertValidContent(content, format = 'js-export-array') {
  if (format === 'json-array') {
    try { JSON.parse(content); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; }
  }
  try {
    // eslint-disable-next-line no-new-func
    new Function(content.replace(/^export default/m, 'return'));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Shared FAQ item validation/dedup for every writer that accepts a draft's
// `content.items` — never trusts the generator output blindly. Trims
// whitespace, rejects anything not a clean {question, answer} pair of
// non-empty strings, and dedupes by case-insensitive trimmed question text
// (last occurrence wins, so a corrected duplicate overrides the original).
export function dedupeAndValidateFaqItems(items) {
  if (!Array.isArray(items) || !items.length) {
    return { ok: false, error: 'No FAQ items to validate.' };
  }
  const byQuestion = new Map();
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'A FAQ item is not an object.' };
    const question = typeof raw.question === 'string' ? raw.question.trim() : '';
    const answer = typeof raw.answer === 'string' ? raw.answer.trim() : '';
    if (!question || !answer) return { ok: false, error: `Malformed FAQ item — question and answer must both be non-empty strings (got: ${JSON.stringify(raw)}).` };
    byQuestion.set(question.toLowerCase(), { question, answer });
  }
  const deduped = [...byQuestion.values()];
  if (!deduped.length) return { ok: false, error: 'No valid FAQ items remained after validation.' };
  return { ok: true, items: deduped };
}

// Parses a faqs array interior back into real {question, answer} objects.
// Safe to evaluate here (js-export-array path) — this is the site's own
// already-fetched repo content that already passed (or is about to pass)
// assertValidContent elsewhere in the same flow, not arbitrary input.
// Never throws; returns [] on anything unparseable rather than failing the
// whole preview over a diff-only nicety.
export function parseExistingFaqItems(arrayInterior, format = 'js-export-array') {
  if (format === 'json-array') {
    try {
      const items = JSON.parse(`[${arrayInterior}]`);
      return items.filter((it) => it && typeof it.question === 'string' && typeof it.answer === 'string');
    } catch {
      return [];
    }
  }
  try {
    // eslint-disable-next-line no-new-func
    const items = new Function(`return [${arrayInterior}]`)();
    if (!Array.isArray(items)) return [];
    return items.filter((it) => it && typeof it.question === 'string' && typeof it.answer === 'string');
  } catch {
    return [];
  }
}

// spliceMarkedArray only ever touches the AI-managed region — hand-authored
// items outside it are never read, removed, or reordered. So the
// reviewer's added/modified/removed diff must compare against ONLY what
// was previously AI-managed, never the whole array — otherwise every
// hand-authored FAQ would misleadingly show as "removed" despite the real
// edit leaving it completely untouched. Returns [] when nothing was
// AI-managed yet (this draft's content is then correctly entirely "added").
export function parseManagedFaqItems(arrayInterior, format = 'js-export-array') {
  return format === 'json-array' ? parseManagedFaqItemsJson(arrayInterior) : parseManagedFaqItemsComment(arrayInterior);
}

// Semantic diff for the reviewer's preview — by question text (case-
// insensitive), not array position, so reordering never shows as a false
// modify. `added`/`removed`/`modified`/`unchanged` — `modified` means the
// same question with a different answer. Format-agnostic: operates on
// already-parsed objects.
export function diffFaqItems(existingItems, newItems) {
  const existingByQ = new Map((existingItems || []).map((qa) => [String(qa.question).trim().toLowerCase(), qa]));
  const newByQ = new Map((newItems || []).map((qa) => [String(qa.question).trim().toLowerCase(), qa]));

  const added = [], modified = [], unchanged = [];
  for (const [key, qa] of newByQ) {
    const prior = existingByQ.get(key);
    if (!prior) added.push(qa);
    else if (prior.answer !== qa.answer) modified.push({ before: prior, after: qa });
    else unchanged.push(qa);
  }
  const removed = [...existingByQ.entries()].filter(([key]) => !newByQ.has(key)).map(([, qa]) => qa);

  return { added, modified, removed, unchanged };
}
