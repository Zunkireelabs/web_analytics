// Pure, network-free helpers for editing ONE named `export const <name> = ...` data literal inside a TypeScript (or plain JS) data file —
// the sibling of js-data-splice.js for files that data-array-content cannot serve:
//   export const postFaqs: Record<string, PostFaqItem[]> = { "slug": [ {question, answer}, ... ], ... };   // keyed-record
//   export const blogIndexFaqs: FAQItem[] = [ {question, answer}, ... ];                                    // flat-array
//
// Why not reuse assertValidContent: it validates with `new Function(content)`, which cannot parse `interface`, type annotations or
// `import type` — i.e. any .ts file. So this module NEVER tries to execute the file. It proves an edit safe a different way
// (verifyDataEdit): everything outside the one edited region is byte-identical, and the target literal parses to exactly the old
// value plus the intended change. Every function fails closed — an unrecognised shape returns { ok:false, reason } and the caller
// stops; nothing here ever guesses a target.

import { scanBalanced, spliceMarkedArray, parseManagedFaqItems } from './js-data-splice.js';

const IDENT = /[A-Za-z_$][\w$]*/y;

// Index just past a string literal starting at i (content[i] is the quote). -1 when unterminated.
function skipString(content, i) {
  const quote = content[i];
  i++;
  while (i < content.length && content[i] !== quote) {
    if (content[i] === '\\') i++;
    i++;
  }
  return i < content.length ? i + 1 : -1;
}

// Skips whitespace and comments. Returns the next significant index.
function skipTrivia(content, i, end) {
  for (;;) {
    while (i < end && /\s/.test(content[i])) i++;
    if (content[i] === '/' && content[i + 1] === '/') { const nl = content.indexOf('\n', i); i = nl === -1 ? end : nl + 1; continue; }
    if (content[i] === '/' && content[i + 1] === '*') { const e = content.indexOf('*/', i + 2); i = e === -1 ? end : e + 2; continue; }
    return i;
  }
}

// Locates `export const <exportName> [: <type>] = <{|[>` EXACTLY once, at the start of a line. Returns the bracket kind and the
// interior bounds (start = just after the opening bracket, end = index of the matching closing bracket). Anything else — absent,
// declared twice, not an object/array literal, unbalanced — is a refusal, never a best guess.
export function findNamedExport(content, exportName) {
  if (!/^[A-Za-z_$][\w$]*$/.test(exportName || '')) return { ok: false, reason: 'invalid-config', error: `exportName "${exportName}" is not a valid identifier.` };
  const re = new RegExp(`^export\\s+const\\s+${exportName.replace(/\$/g, '\\$')}\\s*(?::[^=\\n]+?)?=\\s*([\\[{])`, 'gm');
  const found = [...content.matchAll(re)];
  if (found.length === 0) return { ok: false, reason: 'no-insertion-marker', error: `No \`export const ${exportName}\` object/array literal found.` };
  if (found.length > 1) return { ok: false, reason: 'no-insertion-marker', error: `\`export const ${exportName}\` is declared ${found.length} times — refusing to pick one.` };
  const m = found[0];
  const open = m[1];
  const start = m.index + m[0].length;
  const end = scanBalanced(content, start, open, open === '{' ? '}' : ']');
  if (end === -1) return { ok: false, reason: 'no-insertion-marker', error: `\`export const ${exportName}\` literal is not balanced.` };
  return { ok: true, kind: open === '{' ? 'object' : 'array', start, end, declStart: m.index };
}

// Lists the TOP-LEVEL entries of an object literal interior as { key, valueStart, valueEnd } (absolute indexes, valueEnd exclusive,
// trailing whitespace trimmed). Supports bare-identifier and quoted keys only. A spread, computed key, shorthand or method entry
// returns { ok:false } — the object is then not a plain data record and must not be edited.
export function listTopLevelEntries(content, start, end) {
  const entries = [];
  let i = start;
  for (;;) {
    i = skipTrivia(content, i, end);
    while (i < end && content[i] === ',') i = skipTrivia(content, i + 1, end);
    if (i >= end) break;

    let key;
    if (content[i] === '"' || content[i] === "'") {
      const e = skipString(content, i);
      if (e === -1) return { ok: false, error: 'Unterminated key string.' };
      key = content.slice(i + 1, e - 1);
      i = e;
    } else {
      IDENT.lastIndex = i;
      const id = IDENT.exec(content);
      if (!id) return { ok: false, error: `Unsupported entry syntax near "${content.slice(i, i + 20).replace(/\s+/g, ' ')}".` };
      key = id[0];
      i += id[0].length;
    }
    i = skipTrivia(content, i, end);
    if (content[i] !== ':') return { ok: false, error: `Entry "${key}" is not a plain \`key: value\` pair.` };
    i = skipTrivia(content, i + 1, end);

    const valueStart = i;
    let depth = 0;
    while (i < end) {
      const c = content[i];
      if (c === '"' || c === "'" || c === '`') { const e = skipString(content, i); if (e === -1) return { ok: false, error: 'Unterminated string.' }; i = e; continue; }
      if (c === '/' && content[i + 1] === '/') { const nl = content.indexOf('\n', i); i = nl === -1 ? end : nl + 1; continue; }
      if (c === '/' && content[i + 1] === '*') { const e = content.indexOf('*/', i + 2); i = e === -1 ? end : e + 2; continue; }
      if (c === '[' || c === '{' || c === '(') depth++;
      else if (c === ']' || c === '}' || c === ')') depth--;
      else if (c === ',' && depth === 0) break;
      i++;
    }
    if (depth !== 0) return { ok: false, error: `Entry "${key}" has unbalanced brackets.` };
    let valueEnd = i;
    while (valueEnd > valueStart && /\s/.test(content[valueEnd - 1])) valueEnd--;
    entries.push({ key, valueStart, valueEnd });
  }
  return { ok: true, entries };
}

// Evaluates a plain data literal (objects, arrays, strings, numbers, booleans, null) WITHOUT running the file: the text is first
// checked against a character allowlist-style tokenizer, so a function call, identifier reference or template placeholder refuses
// instead of executing. Returns { ok, value }.
export function parseDataLiteral(text) {
  let i = 0;
  const bad = () => ({ ok: false });
  function ws() { i = skipTrivia(text, i, text.length); }
  function value() {
    ws();
    const c = text[i];
    if (c === '{') {
      i++; const obj = {};
      for (;;) {
        ws();
        if (text[i] === '}') { i++; return obj; }
        let key;
        if (text[i] === '"' || text[i] === "'") { const e = skipString(text, i); if (e === -1) throw bad(); key = strLit(text.slice(i, e)); i = e; }
        else { IDENT.lastIndex = i; const id = IDENT.exec(text); if (!id) throw bad(); key = id[0]; i += id[0].length; }
        ws(); if (text[i] !== ':') throw bad(); i++;
        obj[key] = value();
        ws(); if (text[i] === ',') i++; else if (text[i] !== '}') throw bad();
      }
    }
    if (c === '[') {
      i++; const arr = [];
      for (;;) {
        ws();
        if (text[i] === ']') { i++; return arr; }
        arr.push(value());
        ws(); if (text[i] === ',') i++; else if (text[i] !== ']') throw bad();
      }
    }
    if (c === '"' || c === "'") { const e = skipString(text, i); if (e === -1) throw bad(); const s = strLit(text.slice(i, e)); i = e; return s; }
    if (c === '`') { const e = skipString(text, i); if (e === -1) throw bad(); const raw = text.slice(i + 1, e - 1); if (raw.includes('${')) throw bad(); i = e; return raw.replace(/\\(.)/g, '$1'); }
    const lit = /^(?:true|false|null|-?\d+(?:\.\d+)?)/.exec(text.slice(i));
    if (!lit) throw bad();
    i += lit[0].length;
    return JSON.parse(lit[0]);
  }
  function strLit(s) {
    const q = s[0];
    if (q === '"') return JSON.parse(s);
    // Single-quoted: convert to a JSON string safely.
    const inner = s.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"');
    return JSON.parse(`"${inner}"`);
  }
  try {
    const v = value(); ws();
    if (i !== text.length) return { ok: false };
    return { ok: true, value: v };
  } catch (e) {
    return e && e.ok === false ? e : { ok: false };
  }
}

// Resolves where the draft's items go. keyed-record: the entry for `key` (absent -> { absent:true } with the object bounds, the
// caller decides whether creating it is allowed). flat-array: the root array itself.
export function locateTarget(content, { exportName, shape, key }) {
  const exp = findNamedExport(content, exportName);
  if (!exp.ok) return exp;
  if (shape === 'flat-array') {
    if (exp.kind !== 'array') return { ok: false, reason: 'invalid-config', error: `\`${exportName}\` is an object, but the config says shape "flat-array".` };
    return { ok: true, exp, arrayRange: { start: exp.start, end: exp.end } };
  }
  if (exp.kind !== 'object') return { ok: false, reason: 'invalid-config', error: `\`${exportName}\` is an array, but the config says shape "keyed-record".` };
  const listed = listTopLevelEntries(content, exp.start, exp.end);
  if (!listed.ok) return { ok: false, reason: 'no-insertion-marker', error: `\`${exportName}\` is not a plain keyed record (${listed.error}) — refusing to edit it.` };
  const matches = listed.entries.filter((e) => e.key === key);
  if (matches.length > 1) return { ok: false, reason: 'no-insertion-marker', error: `Key "${key}" appears ${matches.length} times in \`${exportName}\` — refusing to pick one.` };
  if (matches.length === 0) return { ok: true, exp, absent: true, entries: listed.entries };
  const e = matches[0];
  if (content[e.valueStart] !== '[' || content[e.valueEnd - 1] !== ']') {
    return { ok: false, reason: 'no-insertion-marker', error: `Entry "${key}" in \`${exportName}\` is not an array literal — refusing to edit it.` };
  }
  return { ok: true, exp, arrayRange: { start: e.valueStart + 1, end: e.valueEnd - 1 }, entry: e };
}

// Writes `items` into the AI-managed (SEOAI:FAQ) region of the target. For a keyed-record whose key is absent, the key is created
// ONLY when `create` is true (the caller proves the key names a real page first). Hand-authored items are never touched.
export function writeItems(content, target, { exportName, shape, key, items, create }) {
  if (target.arrayRange) {
    const priorManaged = parseManagedFaqItems(content.slice(target.arrayRange.start, target.arrayRange.end), 'js-export-array');
    return { ok: true, content: spliceMarkedArray(content, target.arrayRange, items, 'js-export-array'), priorManaged, created: false };
  }
  if (shape !== 'keyed-record' || !target.absent) return { ok: false, reason: 'no-insertion-marker', error: 'No array to write into.' };
  if (!create) return { ok: false, reason: 'target-not-identified', error: `"${key}" has no entry yet and this site's config does not allow creating one.` };
  const { start, end } = target.exp;
  const interior = content.slice(start, end);
  const trimmed = interior.replace(/\s+$/, '');
  const needsComma = trimmed.trim().length > 0 && !trimmed.endsWith(',');
  const at = start + trimmed.length;
  const withKey = `${content.slice(0, at)}${needsComma ? ',' : ''}\n  ${JSON.stringify(key)}: [],${content.slice(at, end).startsWith('\n') ? '' : '\n'}${content.slice(at)}`;
  const relocated = locateTarget(withKey, { exportName, shape, key });
  if (!relocated.ok || !relocated.arrayRange) return { ok: false, reason: 'invalid-edit', error: 'Could not re-locate the newly created entry.' };
  return { ok: true, content: spliceMarkedArray(withKey, relocated.arrayRange, items, 'js-export-array'), priorManaged: [], created: true };
}

// The safety proof (never executes the file). Checks:
//  1. everything before the target export and after it is byte-identical,
//  2. keyed-record: every OTHER key's value is deep-equal, and no other key was added,
//  3. the target's hand-authored items (everything that was not in the previous AI-managed region) are unchanged and in order,
//  4. every one of the new items is present, and every item is a non-empty { question, answer } string pair.
export function verifyDataEdit(before, after, { exportName, shape, key, newItems, priorManaged = [] }) {
  const b = findNamedExport(before, exportName);
  const a = findNamedExport(after, exportName);
  if (!b.ok || !a.ok) return { ok: false, error: 'Target export could not be re-located after the edit.' };
  if (before.slice(0, b.declStart) !== after.slice(0, a.declStart)) return { ok: false, error: 'Text before the target export changed.' };
  if (before.slice(b.end) !== after.slice(a.end)) return { ok: false, error: 'Text after the target export changed.' };
  const pb = parseDataLiteral(before.slice(b.start - 1, b.end + 1));
  const pa = parseDataLiteral(after.slice(a.start - 1, a.end + 1));
  if (!pb.ok) return { ok: false, error: `${exportName} (before the edit) is not a plain data literal, so the edit cannot be verified.` };
  if (!pa.ok) return { ok: false, error: `${exportName} (after the edit) does not parse as a plain data literal.` };

  let beforeItems; let afterItems;
  if (shape === 'flat-array') {
    beforeItems = pb.value; afterItems = pa.value;
  } else {
    for (const k of Object.keys(pb.value)) {
      if (k !== key && JSON.stringify(pb.value[k]) !== JSON.stringify(pa.value[k])) return { ok: false, error: `Entry "${k}" was changed by the edit.` };
    }
    for (const k of Object.keys(pa.value)) if (!(k in pb.value) && k !== key) return { ok: false, error: `Unexpected new entry "${k}".` };
    beforeItems = pb.value[key] || []; afterItems = pa.value[key];
  }
  const isItem = (x) => x && typeof x.question === 'string' && x.question.trim() && typeof x.answer === 'string' && x.answer.trim();
  if (!Array.isArray(beforeItems) || !Array.isArray(afterItems) || !afterItems.every(isItem)) return { ok: false, error: 'Target array contains a malformed item.' };

  const J = (x) => JSON.stringify({ question: x.question, answer: x.answer });
  const prior = new Set(priorManaged.map(J));
  const fresh = new Set(newItems.map(J));
  const handBefore = beforeItems.filter((x) => !prior.has(J(x))).map(J);
  const handAfter = afterItems.filter((x) => !fresh.has(J(x))).map(J);
  if (JSON.stringify(handBefore) !== JSON.stringify(handAfter)) return { ok: false, error: 'Hand-authored items were changed by the edit.' };
  const afterJ = new Set(afterItems.map(J));
  if (![...fresh].every((j) => afterJ.has(j))) return { ok: false, error: 'Not every new item landed in the file.' };
  return { ok: true };
}
