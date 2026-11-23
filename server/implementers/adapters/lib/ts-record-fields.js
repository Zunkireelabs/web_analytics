// Pure, network-free helpers for editing the FIELDS of one entry in a named `export const <name> = { "<key>": { title, description }, ... }` data record inside a
// TypeScript (or JS) data file. The sibling of ts-export-data.js, which does the same for entries that are LISTS (post-faqs.ts); this is for entries that are small
// OBJECTS, e.g. admizz-web-dev's
//   src/data/post-seo-overrides.ts   export const postSeoOverrides: Record<string, { title: string; description: string }> = { "<post-slug>": { title, description } }
// read by /[slug]/page.tsx in preference to the post's own seo.metaTitle / seo.metaDescription, which is the site's own place for SEO wording ("ships with the site code,
// reviewed in a PR, instead of editing the post file").
//
// Same safety standard as ts-export-data.js: the file is never executed. An edit is proven safe by verifyRecordEdit: the text before and after the export is byte-identical,
// every OTHER entry is deep-equal, and the target entry is exactly what was intended. Every function fails closed: an unrecognised shape returns { ok:false, reason } and the
// caller stops. Nothing here ever guesses a target.

import { findNamedExport, listTopLevelEntries, parseDataLiteral } from './ts-export-data.js';

const FIELD_NAME = /^[A-Za-z_$][\w$]*$/;
const lineIndentAt = (content, index) => {
  const ls = content.lastIndexOf('\n', index) + 1;
  const m = /^[ \t]*/.exec(content.slice(ls, index));
  return m ? m[0] : '';
};

// Where the entry for `key` is. { ok:true, exp, entries, entry } (entry undefined when the key is absent), or a refusal.
export function locateRecordEntry(content, { exportName, key }) {
  const exp = findNamedExport(content, exportName);
  if (!exp.ok) return exp;
  if (exp.kind !== 'object') return { ok: false, reason: 'invalid-config', error: `\`${exportName}\` is an array, but this adapter edits a keyed record (an object).` };
  const listed = listTopLevelEntries(content, exp.start, exp.end);
  if (!listed.ok) return { ok: false, reason: 'no-insertion-marker', error: `\`${exportName}\` is not a plain keyed record (${listed.error}), so it is not edited.` };
  const matches = listed.entries.filter((e) => e.key === key);
  if (matches.length > 1) return { ok: false, reason: 'no-insertion-marker', error: `Key "${key}" appears ${matches.length} times in \`${exportName}\`, so it is not edited.` };
  return { ok: true, exp, entries: listed.entries, entry: matches[0] };
}

const lit = (v) => (typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v));

// The object literal for an entry, in the file's own style: one field per line, trailing commas, unquoted field names.
export function renderObject(fields, { indent = '  ' } = {}) {
  const inner = `${indent}  `;
  const lines = Object.entries(fields).map(([k, v]) => `${inner}${FIELD_NAME.test(k) ? k : JSON.stringify(k)}: ${lit(v)},`);
  return `{\n${lines.join('\n')}\n${indent}}`;
}

/**
 * Writes `fields` into the entry for `key`. An existing entry keeps every field it already had (in its order) except the ones given; an absent entry is created only when
 * `create` is true (the caller proves the key names a real page first).
 * @returns {{ ok:true, content, created, before, after } | { ok:false, reason, error }}
 */
export function writeRecordFields(content, located, { key, fields, create }) {
  if (located.entry) {
    const e = located.entry;
    const text = content.slice(e.valueStart, e.valueEnd);
    if (text[0] !== '{' || text[text.length - 1] !== '}') {
      return { ok: false, reason: 'no-insertion-marker', error: `Entry "${key}" is not an object literal, so it is not edited.` };
    }
    const parsed = parseDataLiteral(text);
    if (!parsed.ok || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
      return { ok: false, reason: 'non-literal-existing-value', error: `Entry "${key}" is not a plain data object (it may reference another module or build a value), so it is not edited.` };
    }
    const merged = { ...parsed.value };
    for (const [k, v] of Object.entries(fields)) if (v != null) merged[k] = v;
    const indent = lineIndentAt(content, e.valueStart);
    const next = renderObject(merged, { indent });
    return { ok: true, content: content.slice(0, e.valueStart) + next + content.slice(e.valueEnd), created: false, before: parsed.value, after: merged };
  }
  if (!create) return { ok: false, reason: 'target-not-identified', error: `"${key}" has no entry yet and this site's config does not allow creating one.` };
  const missing = Object.entries(fields).filter(([, v]) => v == null).map(([k]) => k);
  if (missing.length) return { ok: false, reason: 'draft-not-ready', error: `A new entry for "${key}" needs every field, and this draft has none for ${missing.join(', ')}.` };
  const { start, end } = located.exp;
  const interior = content.slice(start, end);
  const trimmed = interior.replace(/\s+$/, '');
  const needsComma = trimmed.trim().length > 0 && !trimmed.endsWith(',');
  const at = start + trimmed.length;
  const indent = located.entries.length ? lineIndentAt(content, located.entries[located.entries.length - 1].valueStart) : '  ';
  const entryText = `${JSON.stringify(key)}: ${renderObject(fields, { indent })},`;
  const rest = content.slice(at);
  const tail = rest.startsWith('\n') ? '' : '\n';
  const out = `${content.slice(0, at)}${needsComma ? ',' : ''}\n${indent}${entryText}${tail}${rest}`;
  return { ok: true, content: out, created: true, before: null, after: fields };
}

/**
 * The safety proof. Checks that (1) the text before and after the export is byte-identical, (2) every OTHER entry is deep-equal and no other entry appeared, and
 * (3) the target entry is exactly `expected`.
 */
export function verifyRecordEdit(before, after, { exportName, key, expected }) {
  const b = findNamedExport(before, exportName);
  const a = findNamedExport(after, exportName);
  if (!b.ok || !a.ok) return { ok: false, error: 'The target export could not be found again after the edit.' };
  if (before.slice(0, b.declStart) !== after.slice(0, a.declStart)) return { ok: false, error: 'Text before the target export changed.' };
  if (before.slice(b.end) !== after.slice(a.end)) return { ok: false, error: 'Text after the target export changed.' };
  const pb = parseDataLiteral(before.slice(b.start - 1, b.end + 1));
  const pa = parseDataLiteral(after.slice(a.start - 1, a.end + 1));
  if (!pb.ok) return { ok: false, error: `${exportName} (before the edit) is not a plain data literal, so the edit cannot be verified.` };
  if (!pa.ok) return { ok: false, error: `${exportName} (after the edit) does not parse as a plain data literal.` };
  for (const k of Object.keys(pb.value)) {
    if (k !== key && JSON.stringify(pb.value[k]) !== JSON.stringify(pa.value[k])) return { ok: false, error: `Entry "${k}" was changed by the edit.` };
  }
  for (const k of Object.keys(pa.value)) if (!(k in pb.value) && k !== key) return { ok: false, error: `An unexpected new entry "${k}" appeared.` };
  if (JSON.stringify(pa.value[key]) !== JSON.stringify(expected)) return { ok: false, error: `Entry "${key}" is not what was intended after the edit.` };
  return { ok: true };
}
