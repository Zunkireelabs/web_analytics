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

// json-array always quotes keys (valid JSON has no other form); js-export-
// array only NEEDS to when the key isn't a bare valid JS identifier — e.g. a
// hyphenated slug like "ai-development" used as a services.<id> property
// name (a real, common case: this platform's own location×service pages key
// their nested content on a URL slug). Rendering an unquoted hyphenated key
// would be a silent syntax break (`ai-development: {}` parses as a
// subtraction expression, not a property), so both insertNewScalarField and
// insertNewObjectField below share this rather than each guessing.
function renderKey(fieldName, format) {
  if (format === 'json-array' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(fieldName)) return JSON.stringify(fieldName);
  return fieldName;
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

// Exported for the 'flat-array' shape (adapters/data-array-content.js): a
// content file whose root array IS the item list directly (e.g.
// zunkireelabs-web's faq.json — a bare `[{question,answer}, ...]`), as
// opposed to today's array-of-parent-objects-matched-by-id shape
// (locations.js/comparisons.js). Same bounds-finding either way — only the
// caller's notion of "what these bounds mean" differs.
export function findRootArrayBounds(content, format) {
  const pattern = ROOT_ARRAY_PATTERN_BY_FORMAT[format];
  if (!pattern) return null;
  const m = pattern.exec(content);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = scanBalanced(content, start, '[', ']');
  if (end === -1) return null;
  return { start, end };
}

// JSON requires quoted keys always. js-export-array's real files mostly use
// unquoted keys (title, id, services — valid bare JS identifiers) but quote
// a key that isn't one (e.g. "aeo-seo", "ai-customer-experience" — hyphens
// aren't legal in an unquoted property name), confirmed directly against
// zunkireelabs-web's own locations.js nested `services` object — so
// js-export-array must accept either form, not just the unquoted one.
// Wrapped in a non-capturing group so every caller's own prefix (e.g.
// findScalarFieldRange's negative lookbehind guard) applies to the whole
// alternation as one unit, not just the first branch.
function keyRegexSource(field, format) {
  const escaped = escapeRegExp(field);
  return format === 'json-array'
    ? `"${escaped}"\\s*:`
    : `(?:"${escaped}"|'${escaped}'|${escaped})\\s*:`;
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

// Root bounds for a data file whose top level is an OBJECT keyed by id
// (`{ "some-id": {...}, "other-id": {...} }` — e.g. zunkireelabs-web's own
// productsDetails.json/servicesDetails.json), the object counterpart to
// findRootArrayBounds's `[...]` above. Once these bounds are known, the
// per-id entry is just an ordinary findObjectFieldRange lookup (a "root
// object" is not structurally different from any other object a field
// lookup already knows how to search inside) — no separate entry-lookup
// primitive needed.
export function findRootObjectBounds(content) {
  const start = content.indexOf('{');
  if (start === -1) return null;
  const end = scanBalanced(content, start + 1, '{', '}');
  if (end === -1) return null;
  return { start, end };
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

// Returns the byte offset of `key: {` ONLY if it appears as a direct
// property of the object at `objRange` — the object-valued counterpart to
// findTopLevelArrayKeyStart above (which does the same for `key: [`). Same
// depth-tracking scan, just targeting `{`/`}` instead of `[`/`]`.
function findTopLevelObjectKeyStart(content, objRange, fieldName, format) {
  const keyRe = new RegExp(`${keyRegexSource(fieldName, format)}\\s*\\{`, 'g');
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

// The { start, end } (inclusive of the braces themselves, same convention
// as findObjectRange) of an EXISTING `fieldName: { ... }` object directly
// inside the given object — null if absent. This is what makes a nested
// lookup possible (e.g. a location's own `services.<serviceId>` sub-object
// in zunkireelabs-web's locations.js — a plain KEYED object, not an array
// of {id, ...} entries, so findObjectRange's id-field matching doesn't
// apply here; the "id" IS the property name). Calling this twice —
// (objRange, 'services') then (that result, the specific service id) — is
// how adapters/data-array-content.js resolves a two-level nested target
// without a third, bespoke lookup function.
export function findObjectFieldRange(content, objRange, fieldName, format = 'js-export-array') {
  const keyStart = findTopLevelObjectKeyStart(content, objRange, fieldName, format);
  if (keyStart === -1) return null;
  const braceIdx = content.indexOf('{', keyStart);
  const end = scanBalanced(content, braceIdx + 1, '{', '}');
  if (end === -1) return null;
  return { start: braceIdx, end };
}

// Locates the value range of an EXISTING top-level `fieldName: "..."` /
// 'value'-string scalar property directly inside the given object — the
// scalar counterpart to findTopLevelArrayKeyStart/findArrayFieldRange
// above, used for writing a single title/description string (e.g. into
// locations.js/comparisons.js) rather than splicing a nested array.
// Deliberately conservative in three ways an array field doesn't need to
// be: (1) a leading negative lookbehind on the unquoted js-export-array key
// so `title:` never matches inside `subtitle:` — quoted json-array keys
// don't have this risk since the value's own closing quote is part of the
// key match itself; (2) only a plain `"..."`/`'...'` value is accepted — a
// template literal (`` `...${x}...` ``) or any non-string value is left
// alone rather than guessed at, since a static splice can't safely reason
// about real interpolation; (3) more than one top-level match (shouldn't
// happen for a well-formed object, but same "don't guess" posture as
// findObjectRange's zero-or-many -> null) returns null.
export function findScalarFieldRange(content, objRange, fieldName, format = 'js-export-array') {
  const keySrc = format === 'json-array' ? keyRegexSource(fieldName, format) : `(?<![A-Za-z0-9_$])${keyRegexSource(fieldName, format)}`;
  const keyRe = new RegExp(keySrc, 'g');
  keyRe.lastIndex = objRange.start + 1;
  const found = [];
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
    if (depth === 0) {
      let j = m.index + m[0].length;
      while (j < content.length && /\s/.test(content[j])) j++;
      const quote = content[j];
      if (quote === '"' || quote === "'" || quote === '`') {
        let k = j + 1;
        while (k < content.length && content[k] !== quote) { if (content[k] === '\\') k++; k++; }
        if (k < content.length) {
          // A backtick field holding real `${...}` interpolation is not a
          // plain string value -- this splicer works by string-scanning,
          // never evaluating JS, so it has no way to know what that
          // expression means or whether overwriting it would be safe.
          // Refused outright (not found, same as any other disqualified
          // field) rather than guessed at, matching every other ambiguous
          // case in this file. Plain multi-line template-literal content
          // (zunkireelabs-web's own locations.js/glossary.js/comparisons.js
          // `content` fields, none of which interpolate) is the case this
          // exists to support -- only fields that actually interpolate are
          // excluded.
          const isDisqualifiedTemplateLiteral = quote === '`' && content.slice(j + 1, k).includes('${');
          if (!isDisqualifiedTemplateLiteral) found.push({ valueStart: j, valueEnd: k + 1, quote });
        }
      }
    }
    keyRe.lastIndex = m.index + 1;
  }
  return found.length === 1 ? found[0] : null;
}

// Answers "does this key exist at all at the top level of objRange" —
// regardless of whether its value is a plain string findScalarFieldRange
// would accept. Exists so a caller that's about to fall back to
// insertNewScalarField (its normal "this field has never been set before"
// path) can first tell that apart from "this field exists but holds
// something findScalarFieldRange won't touch" (a template-literal
// interpolation, or — the real case this was written for — a reference
// expression like `birgunjData.meta.title` sourced from another module).
// Falling through to insert-as-new in that second case doesn't fail safely:
// it appends a SECOND same-named key after the first, which is syntactically
// valid JS (the later duplicate silently wins at runtime) but leaves the
// original reference expression as dead, confusing source, and would
// silently duplicate again on every subsequent draft against the same
// field. Same depth-tracking scan as findScalarFieldRange, minus the
// quoted-value requirement.
export function scalarFieldKeyExists(content, objRange, fieldName, format = 'js-export-array') {
  const keySrc = format === 'json-array' ? keyRegexSource(fieldName, format) : `(?<![A-Za-z0-9_$])${keyRegexSource(fieldName, format)}`;
  const keyRe = new RegExp(keySrc, 'g');
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
    if (depth === 0) return true;
    keyRe.lastIndex = m.index + 1;
  }
  return false;
}

// Escapes a value for embedding in a single-line, single/double-quoted JS
// string literal: backslashes and the delimiting quote (as spliceScalarField
// always did), PLUS raw newlines/carriage returns -- an unescaped line
// terminator inside "..."/'...' is a syntax error (unterminated string), not
// just cosmetic. This is the exact shape expand-content's rendered
// multi-line HTML (marker-merge.js's renderExpandedHtml, `\n` between the
// heading and body of every section) was hitting: assertValidContent
// correctly refused to apply rather than write broken JS, but every
// expand-content draft on a data-array-content page failed for it, forever,
// since nothing upstream produces single-line values. U+2028/U+2029 (line/
// paragraph separator) are also illegal unescaped in a JS string literal per
// spec, unlike in a template literal -- escaped here too for the same reason.
function escapeJsStringLiteral(value, quote) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(new RegExp(escapeRegExp(quote), 'g'), `\\${quote}`);
}

// Counterpart to escapeJsStringLiteral for a backtick-delimited field
// (findScalarFieldRange only ever hands this quote='`' for a field it has
// already confirmed holds no `${...}` interpolation). Escapes backslashes,
// the backtick delimiter itself, and any `${` sequence in the NEW value --
// the last one is not optional: without it, generated content that happens
// to contain a literal "${" (rare, but real prose can) would silently turn
// into live interpolation syntax in the written file. Raw newlines/CR are
// deliberately left untouched, unlike escapeJsStringLiteral -- a template
// literal allows them literally, which is the entire reason to prefer this
// quote type for multi-line generated content (expand-content's rendered
// HTML) instead of always forcing it through \n-escaped "..."/'...'.
function escapeJsTemplateLiteral(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

// Replaces an existing scalar field's string value in place, re-escaping
// backslashes and the field's own quote character the same minimal way
// lib/marker-merge.js's applyMarker does for a LINE marker's quoted value —
// null (no edit made) on anything findScalarFieldRange itself refused to
// resolve, leaving the caller's existing "couldn't find it" failure honest.
export function spliceScalarField(content, objRange, fieldName, newValue, format = 'js-export-array') {
  const range = findScalarFieldRange(content, objRange, fieldName, format);
  if (!range) return null;
  const escaped = range.quote === '`'
    ? escapeJsTemplateLiteral(String(newValue))
    : escapeJsStringLiteral(String(newValue), range.quote);
  return content.slice(0, range.valueStart) + range.quote + escaped + range.quote + content.slice(range.valueEnd);
}

// Inserts a brand-new `fieldName: "..."` string property as the object's
// last field — same insertion strategy/comma-safety as insertNewObjectField
// below, for a scalar string value instead of an object literal. Use only
// when findScalarFieldRange returned null (the field genuinely doesn't
// exist yet on this entry, e.g. a page-content field like expandedContent
// that's never been written before); once created, later drafts go through
// spliceScalarField instead. Same escaping as spliceScalarField, always
// double-quoted since the key is brand new (no existing quote style to
// match).
export function insertNewScalarField(content, objRange, fieldName, newValue, format = 'js-export-array') {
  const interior = content.slice(objRange.start + 1, objRange.end);
  const trimmed = interior.replace(/\s+$/, '');
  const needsComma = trimmed.length > 0 && !trimmed.endsWith(',');
  const insertPoint = objRange.start + 1 + trimmed.length;
  const key = renderKey(fieldName, format);
  const escaped = escapeJsStringLiteral(String(newValue), '"');
  const insertion = `${needsComma ? ',' : ''}\n    ${key}: "${escaped}"\n  `;
  return content.slice(0, insertPoint) + insertion + content.slice(objRange.end);
}

// Renders a plain JS value as valid object-literal source — JSON.stringify's
// quoted-key output is valid syntax in BOTH js-export-array (a real .js
// file — quoted keys are legal JS) and json-array (real JSON) formats, so
// one renderer serves both, unlike the FAQ-items path below which needs
// per-format marker/sentinel handling for idempotent re-application. A
// schema/JSON-LD field is a single opaque object, always fully replaced
// wholesale on redraft — there's no "existing items to preserve" concept
// for it the way there is for a hand-authored FAQ array.
function renderObjectLiteral(value, indent) {
  return JSON.stringify(value, null, 2).split('\n').join(`\n${indent}`);
}

// Replaces an EXISTING top-level `fieldName: {...}` object property's value
// wholesale — the object counterpart to spliceScalarField above (a plain
// string value). null (no edit made) when the field doesn't exist yet on
// this entry — see insertNewObjectField for that case, same split as
// findArrayFieldRange/insertNewArrayField above.
export function spliceObjectField(content, objRange, fieldName, newValue, format = 'js-export-array') {
  const range = findObjectFieldRange(content, objRange, fieldName, format);
  if (!range) return null;
  return content.slice(0, range.start) + renderObjectLiteral(newValue, '  ') + content.slice(range.end + 1);
}

// Inserts a brand-new `fieldName: {...}` property as the object's last
// field — comma-safe relative to whatever field currently comes last, same
// insertion strategy as insertNewArrayField above. Use only when
// findObjectFieldRange returned null (the field genuinely doesn't exist
// yet); once created, later drafts go through spliceObjectField instead.
export function insertNewObjectField(content, objRange, fieldName, newValue, format = 'js-export-array') {
  const interior = content.slice(objRange.start + 1, objRange.end);
  const trimmed = interior.replace(/\s+$/, '');
  const needsComma = trimmed.length > 0 && !trimmed.endsWith(',');
  const insertPoint = objRange.start + 1 + trimmed.length;
  const key = renderKey(fieldName, format);
  const insertion = `${needsComma ? ',' : ''}\n    ${key}: ${renderObjectLiteral(newValue, '    ')}\n  `;
  return content.slice(0, insertPoint) + insertion + content.slice(objRange.end);
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

// Removes the ONE item from an existing array field whose `fieldName` value
// is in `matchValues` (a caller-supplied list of acceptable variants — e.g.
// href-rewrite-inject.js's hrefVariants, so an absolute vs. site-relative
// URL both match) — the array-of-plain-objects counterpart to
// findObjectRange's id lookup, but for REMOVAL rather than an in-place
// field write, used by broken-link-fix's data-array-source layer (see
// implementers/backend.js) to drop one dead `resources[]`-style entry from
// a shared data file. Zero or more-than-one matches return null, same
// "don't guess" posture as every other lookup in this file. Only
// json-array format is supported (real, current shape of every array this
// targets) — re-serializes the WHOLE array on removal rather than a
// byte-preserving splice, same documented tradeoff spliceMarkedArrayJson
// above already accepts for pure JSON's lack of comment anchors.
export function removeArrayItemByField(content, arrayRange, fieldName, matchValues, format = 'json-array') {
  if (format !== 'json-array') return null;
  const interior = content.slice(arrayRange.start, arrayRange.end);
  let items;
  try { items = JSON.parse(`[${interior}]`); } catch { return null; }
  const matches = items.filter((it) => it && typeof it[fieldName] === 'string' && matchValues.includes(it[fieldName]));
  if (matches.length !== 1) return null;
  const remaining = items.filter((it) => it !== matches[0]);
  const indent = '    ';
  const body = remaining.map((it) => `${indent}${JSON.stringify(it, null, 2).split('\n').join(`\n${indent}`)}`).join(',\n');
  const newInterior = remaining.length ? `\n${body}\n${indent.slice(2)}` : '';
  return content.slice(0, arrayRange.start) + newInterior + content.slice(arrayRange.end);
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
