// Editing a draft's wording in plain fields, for EVERY kind of draft in the Action Center (a meta title, an Open Graph card, a FAQ, a schema description, a blog post...).
// The draft's structure never changes: only the text a reader would see can be edited, field by field, and what cannot be edited (addresses, image paths, the grounding text the
// post was written from, anything that is not wording) is not offered and is refused if sent. A change must pass the same quality gate as a new draft, counting only problems the
// change itself introduces, and a number nothing supports is refused.
import { findUngroundedClaims } from '../generators/lib/claim-grounding-guard.js';

// Keys whose string value is wording a person may edit.
const EDITABLE_KEY = /^(title|metatitle|selectedtitle|seotitle|description|metadescription|seodescription|headline|subheadline|heading|body|text|summary|question|answer|quickanswer|directanswer|label|alt|caption|name|translatedtitle|translatedmetadescription|translatedcontent|content)$/i;
const NEVER = /^(groundingcontext|sources|suggestedinternallinks|suggestedfaqtopics|categories|page|pagetype|url|href|file|path|selector|image|sourcecontent|sourcetitle|sourcemetadescription|targetlanguage|publishedat|slug|id)$/i;
const MAX_FIELDS = 80;
const MAX_LEN = 12000;

const FRIENDLY = { sections: 'Section', faqItems: 'FAQ', featuredImage: 'Cover image', quickAnswer: 'Short answer', metaDescription: 'Meta description', seoTitle: 'SEO title', seoDescription: 'SEO description', selectedTitle: 'Title', body: 'Text', alt: 'Image description', directAnswer: 'Direct answer', translatedTitle: 'Translated title', translatedMetaDescription: 'Translated meta description', translatedContent: 'Translated text' };
const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
const labelOf = (path) => {
  const tokens = [];
  for (const seg of path.split('.')) {
    if (/^\d+$/.test(seg)) { if (tokens.length) tokens[tokens.length - 1] += ` ${Number(seg) + 1}`; continue; }
    tokens.push(FRIENDLY[seg] || cap(seg.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()));
  }
  return tokens.join(' › ');
};

// Drafts whose content is code, markup, addresses or configuration, not wording a reader sees: a generic key such as `name` or `description` inside them (JSON-LD, a redirect rule, a header) is
// structure, so nothing in them is offered for editing here.
export const NOT_WORDING_TYPES = new Set([
  'schema', 'schema-repair', 'analytics-install', 'breadcrumbs', 'canonical', 'compression-nginx', 'duplicate-id-fix', 'html-lang', 'indexnow', 'llms-txt', 'redirect-add',
  'redirect-chain-nginx', 'redirect-fix', 'robots-bootstrap', 'robots-fix', 'security-headers', 'sitemap', 'sitemap-frontmatter-exclude', 'sitemap-removal', 'soft-404-nginx',
  'viewport', 'broken-link-fix', 'content-integrity-repair', 'blog-pagination', 'location-service-bootstrap', 'geo-audit', 'blog-image',
]);

/** The editable text of a draft: [{ path, label, value, long }] in reading order. `actionType` (when known) keeps structural drafts out. */
export function editableFields(content, actionType = null) {
  if (actionType && NOT_WORDING_TYPES.has(actionType)) return [];
  const out = [];
  const walk = (node, path, key) => {
    if (out.length >= MAX_FIELDS) return;
    if (typeof node === 'string') {
      if (key && EDITABLE_KEY.test(key) && !NEVER.test(key) && node.length <= MAX_LEN) out.push({ path: path.join('.'), label: labelOf(path.join('.')), value: node, long: node.length > 90 || node.includes('\n') });
      return;
    }
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, [...path, String(i)], key)); return; }
    if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) { if (!NEVER.test(k)) walk(v, [...path, k], k); }
  };
  walk(content, [], null);
  return out;
}

const getAt = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setAt(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
  o[keys[keys.length - 1]] = value;
}
const bad = (message) => Object.assign(new Error(message), { status: 400 });

/** The content with these edits applied ({ path: newText }). Only an editable field can change; a field cannot be emptied; the structure is never touched. */
export function applyContentEdits(content, edits, actionType = null) {
  const allowed = new Map(editableFields(content, actionType).map((f) => [f.path, f]));
  const next = JSON.parse(JSON.stringify(content || {}));
  const changed = [];
  for (const [path, raw] of Object.entries(edits || {})) {
    const field = allowed.get(path);
    if (!field) throw bad('That part of the draft cannot be edited.');
    const value = String(raw ?? '').replace(/\r\n/g, '\n').trim();
    if (!value) throw bad(`"${field.label}" cannot be empty.`);
    if (value.length > MAX_LEN) throw bad(`"${field.label}" is too long.`);
    if (value === String(getAt(content, path)).trim()) continue;
    setAt(next, path, value);
    changed.push({ path, label: field.label, value });
  }
  return { content: next, changed };
}

/** Saves edits to a draft nobody has approved yet. `runGate`, `save` are injected. Returns { ok, draft, fields } or { ok: false, status, reason, error, issues? }. */
export async function editDraftContent(site, draft, edits, { runGate, save }) {
  if (!['draft', 'edited', 'submitted_for_approval', 'revision_requested'].includes(draft?.status)) return { ok: false, status: 409, reason: 'not-editable', error: 'This draft has already been approved or shipped, so it cannot be edited here.' };
  let applied;
  try { applied = applyContentEdits(draft.content, edits, draft.action_type); } catch (err) { if (err.status === 400) return { ok: false, status: 400, reason: 'bad-edit', error: err.message }; throw err; }
  if (!applied.changed.length) return { ok: false, status: 400, reason: 'no-change', error: 'Nothing was changed.' };
  const issueKey = (i) => `${i.patternId}|${i.path || ''}|${String(i.snippet || i.detail || '').slice(0, 120)}`;
  const before = await runGate(draft.content).catch(() => ({ issues: [] }));
  const existing = new Set((before.issues || []).map(issueKey));
  const gate = await runGate(applied.content);
  const fresh = (gate.issues || []).filter((i) => !existing.has(issueKey(i)));
  // The gate does not read every field for numbers nothing supports; the text just written is checked here.
  // Only a claim THIS edit introduces blocks it: one already in the field's old text was there before and is not the editor's to fix (the same rule the gate issues above follow).
  const oldFields = editableFields(draft.content, draft.action_type);
  const claimKey = (i) => `${i.patternId}|${String(i.snippet || i.detail || '').slice(0, 120)}`;
  for (const c of applied.changed) {
    const was = String(oldFields.find((f) => f.path === c.path)?.value ?? '');
    const grounding = draft.content?.groundingContext || '';
    const old = new Set(findUngroundedClaims({ sections: [{ heading: '', body: was }], groundingContext: grounding }).map(claimKey));
    for (const i of findUngroundedClaims({ sections: [{ heading: '', body: c.value }], groundingContext: grounding })) if (!old.has(claimKey(i))) fresh.push(i);
  }
  if (fresh.length) return { ok: false, status: 422, reason: 'quality-gate', error: 'That change did not pass the checks every draft must pass, so it was not saved.', issues: fresh.map((i) => ({ rule: i.patternId, detail: i.detail || i.snippet || '' })) };
  const saved = await save(applied.content);
  if (!saved) return { ok: false, status: 409, reason: 'not-saved', error: 'This draft changed (approved, sent back or removed) while you were editing, so nothing was saved. Reload and look at it again.' };
  return { ok: true, draft: saved, fields: editableFields(applied.content, draft.action_type), changed: applied.changed.map((c) => c.path) };
}

/** "Tell the writer what to change": the Claude worker rewrites ONE field as asked, and the result goes through exactly the same checks and in-place save as typed text.
 * `callJson(system, user, opts)` is injected (callLLMForJson in production). */
export async function rewriteDraftField(site, draft, { path, instruction, selected } = {}, { runGate, save, callJson }) {
  const field = editableFields(draft?.content, draft?.action_type).find((f) => f.path === path);
  if (!field) return { ok: false, status: 404, reason: 'no-such-field', error: 'That part of the draft was not found.' };
  const ask = String(instruction || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  if (!ask) return { ok: false, status: 400, reason: 'no-instruction', error: 'Tell us what to change.' };
  const picked = String(selected || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  // Exact words selected: rewrite only those and swap them in place, so nothing else in the field moves. Not found exactly once: the whole field is rewritten as before.
  if (picked) {
    const { findSelected, replaceSelected, rewriteSelectedWords } = await import('./selected-words.js');
    if (findSelected(field.value, picked)) {
      try {
        const words = await rewriteSelectedWords({ selected: picked, around: field.value, instruction: ask, callJson });
        const next = replaceSelected(field.value, picked, words);
        if (next != null) {
          if (next === String(field.value)) return { ok: false, status: 422, reason: 'no-change', error: 'The writer did not change anything. Say what you want, for example “make this shorter” or “use a friendlier tone”.' };
          return editDraftContent(site, draft, { [path]: next }, { runGate, save });
        }
      } catch (err) {
        if (err.workerUnavailable || err.llmProvider) return { ok: false, status: 503, reason: 'ai-unavailable', error: 'The writing assistant is not available right now (the Claude worker is offline). Try again in a few minutes, or type the new wording yourself.' };
        if (err.status !== 400) throw err;
      }
    }
  }
  const system = 'You edit ONE piece of wording of a draft for a company website, exactly as the editor asks. Change only what the instruction asks for and keep everything else as it is, including the language, the tone, and about the same length unless they ask otherwise. ' +
    'Never add a statistic, number, date, name or claim that is not already in the text or in the instruction, and never add a link. Respond with ONLY a JSON object: {"text": "the new wording"}';
  const user = `Kind of draft: ${String(draft.action_type || '').replace(/-/g, ' ')}\nPart being edited: ${field.label}\n\nCurrent wording:\n${field.value}${picked ? `\n\nThe editor selected these exact words: "${picked}". Change ONLY those words as asked and keep every other word exactly as it is.` : ''}\n\nWhat the editor wants changed:\n${ask}`;
  let text;
  try {
    const out = await callJson(system, user, { maxTokens: field.long ? 1500 : 400 });
    text = String(out?.text ?? '').trim();
  } catch (err) {
    if (err.workerUnavailable || err.llmProvider) return { ok: false, status: 503, reason: 'ai-unavailable', error: 'The writing assistant is not available right now (the Claude worker is offline). Try again in a few minutes, or type the new wording yourself.' };
    if (err.status === 400) return { ok: false, status: 400, reason: 'bad-edit', error: 'The writing assistant did not return a usable answer. Try asking in other words.' };
    throw err;
  }
  if (!text) return { ok: false, status: 400, reason: 'bad-edit', error: 'The writing assistant came back with nothing. Try asking in other words.' };
  if (text === String(field.value).trim()) return { ok: false, status: 422, reason: 'no-change', error: 'The writer did not change anything. Say what you want, for example “make this shorter” or “use a friendlier tone”.' };
  return editDraftContent(site, draft, { [path]: text }, { runGate, save });
}
