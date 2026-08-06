import { getFileContent } from '../../github/client.js';
import { pushDraftBranch, getOrInitBatchBranch, baseBranch, batchBranchConflictError } from '../lib/github-ops.js';
import { resolveAdapter } from '../lib/url-file-map.js';
import {
  findObjectRange, findArrayFieldRange, findRootArrayBounds, spliceMarkedArray, insertNewArrayField,
  assertValidContent, dedupeAndValidateFaqItems, diffFaqItems, parseManagedFaqItems,
  findScalarFieldRange, spliceScalarField, findObjectFieldRange,
} from './lib/js-data-splice.js';
import { openPrWithSnapshot, rollbackFromSnapshot } from './lib/data-file-writer.js';

// Generic, config-driven writer for "array of objects, one per URL"
// content files (Eleventy pagination data, a plain JSON collection,
// anything with the same shape) — the file path, id field, items field,
// and format all come from the tenant's OWN url_file_map config
// (lib/url-file-map.js's resolveAdapter), never hardcoded here. Replaces
// this session's earlier per-site locations-faq.js/compare-faq.js/
// glossary-faq.js — those each hardcoded one tenant's exact file path and
// field names; this one adapter serves any tenant whose content matches
// this shape, purely through config, same principle backend.js/
// frontend.js already follow for template-file content.
//
// Config shape (see resolveAdapter's doc comment): { id: 'data-array-content',
// format: 'js-export-array' | 'json-array', dataFile: 'src/_data/x.js',
// idField?: 'id', itemsField: 'faqs' }.
//
// `shape: 'flat-array'` is a second, simpler config shape for a data file
// whose root array already IS the item list (e.g. zunkireelabs-web's
// faq.json/aboutFaq.json — a bare `[{question,answer}, ...]`), as opposed
// to the default shape above (an array of parent objects, one per URL,
// each holding its own `itemsField`). In this mode `idField` must be
// absent (there's no parent object to match by id — see the guard in
// computeChange) and `itemsField` is optional/cosmetic only (used solely
// to label the diff, since the root array itself is the target).
//
// `fields` is a THIRD, unrelated config shape — for meta-title (title +
// meta description), not FAQ items: { id: 'data-array-content', format,
// dataFile, idField?, fields: { title: 'title', metaDescription:
// 'description' } }. Maps a meta-title draft's own value keys (fixed:
// 'title' from content.selectedTitle, 'metaDescription' from
// content.metaDescription — see marker-merge.js's buildMergeValues, same
// convention) to the matched object's own plain string field names. Used
// when a page's title/description live as data fields on an Eleventy
// pagination entry (locations.js, comparisons.js) rather than in the page's
// own template — see computeScalarFieldChange below. Deliberately a
// separate code path from the itemsField splice above: only ever writes an
// EXISTING plain string field (findScalarFieldRange in js-data-splice.js
// refuses a template literal or missing field rather than guessing), never
// touches the object's other fields, and carries none of the FAQ-specific
// validation/diffing this array path needs.
//
// `nestedField` is an OPTIONAL addition to either of the two shapes above —
// for a URL that maps to a sub-object nested one level deeper than the
// normal id-matched parent object, e.g. zunkireelabs-web's own
// /locations/<location>/<service>/ pages: the location is matched by
// idField as usual, but the real per-service content lives at
// `services.<serviceId>` on that location object — a plain KEYED object
// (the service id IS the property name), not another id-matched array
// entry. { id: 'data-array-content', format, dataFile, idField, nestedField:
// 'services', fields: {...} } (or itemsField instead of fields). When set,
// the id used to match idField comes from the URL's SECOND-TO-LAST path
// segment instead of the last one, and the last segment becomes the nested
// object's own key (see nestedIdsFromPageUrl/resolveNestedObjectRange
// below) — honestly fails (no-insertion-marker) rather than guessing when
// that nested key doesn't exist, which is the real, correct outcome for a
// parent with no unique content for that specific sub-section yet.
export const meta = {
  id: 'data-array-content',
  description: 'Config-driven writer for array-of-objects content files (Eleventy data arrays, JSON collections) — file path/id field/items field/format all come from the tenant\'s own url_file_map config.',
};

// The id to match within the data file is the URL's own last path
// segment — true of every real case this session (`/locations/kathmandu/`
// -> `kathmandu`, `/compare/zunkiree-vs-algolia/` -> `zunkiree-vs-algolia`,
// `/glossary/rag/` -> `rag`) and the standard shape for this kind of
// "one generated page per data-array id" URL pattern generally, so no
// per-tenant capture-group config is needed for it.
function idFromPageUrl(pageUrl) {
  let path;
  try { path = new URL(pageUrl).pathname; } catch { return null; }
  const segments = path.replace(/\/+$/, '').split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : null;
}

// Two-level counterpart to idFromPageUrl, used ONLY when config.nestedField
// is set (e.g. zunkireelabs-web's /locations/<location>/<service>/ pages —
// a location matched by idField as usual, then its own `services.<service>`
// sub-object, a plain KEYED object rather than another id-matched array —
// see findObjectFieldRange). Real, confirmed shape: outer id is the
// second-to-last path segment, inner id is the last. Requires at least two
// path segments; anything shorter honestly returns nulls rather than
// guessing which single segment means what.
function nestedIdsFromPageUrl(pageUrl) {
  let path;
  try { path = new URL(pageUrl).pathname; } catch { return { id: null, nestedId: null }; }
  const segments = path.replace(/\/+$/, '').split('/').filter(Boolean);
  if (segments.length < 2) return { id: null, nestedId: null };
  return { id: segments[segments.length - 2], nestedId: segments[segments.length - 1] };
}

// Narrows an already-found parent objRange down to its own
// `nestedField.nestedId` sub-object (e.g. a location's `services.aeo-seo`)
// — two findObjectFieldRange calls, since nestedField itself is a keyed
// object property (not an array), same as the id-keyed sub-object inside
// it. Returns null (honest "no match", never a guess) if either level is
// absent — correctly the case for a location with no unique content for
// that service at all (e.g. zunkireelabs-web's non-headquarters locations
// without a `services` object), not a bug to route around.
function resolveNestedObjectRange(content, objRange, config, nestedId) {
  if (!config.nestedField) return objRange;
  const nestedFieldRange = findObjectFieldRange(content, objRange, config.nestedField, config.format || 'js-export-array');
  if (!nestedFieldRange) return null;
  return findObjectFieldRange(content, nestedFieldRange, nestedId, config.format || 'js-export-array');
}

// The meta-title draft value keys this adapter knows how to write, and
// where each one comes from on the draft — kept in exact sync with
// marker-merge.js's buildMergeValues (the equivalent mapping for the
// template-file path) so a page behaves identically regardless of which
// implementer/adapter actually ends up writing it.
function scalarValuesFromDraft(content) {
  const values = {};
  if (content?.selectedTitle) values.title = content.selectedTitle;
  if (content?.metaDescription) values.metaDescription = content.metaDescription;
  return values;
}

// Writes a meta-title draft's selected title/description into an existing
// object's own plain string fields (config.fields) — see this file's
// module comment above for the config shape and the "existing field only,
// never guessed" safety posture. A separate function from computeChange's
// FAQ/items path below: different input validation (a selected title, not
// an items array), different edit primitive (scalar splice, not array
// splice), and a plain changedRegions diff with no FAQ-specific renderMode/
// faqDiff fields that would be meaningless here.
async function computeScalarFieldChange(site, draft, fetchFile, beforeRef, config) {
  const page = draft.content?.page || draft.input?.page;
  const values = scalarValuesFromDraft(draft.content);
  if (!values.title) {
    return { ok: false, reason: 'draft-not-ready', error: 'No title has been selected for this draft yet — pick one of the title proposals first.' };
  }

  const idField = config.idField || 'id';
  const { id, nestedId } = config.nestedField ? nestedIdsFromPageUrl(page) : { id: idFromPageUrl(page), nestedId: null };
  if (!id || (config.nestedField && !nestedId)) return { ok: false, reason: 'no-file-mapping', error: `Could not derive ${config.nestedField ? 'a location + service id pair' : 'an id'} from "${page || '(no page)'}".` };

  const file = await fetchFile(site, config.dataFile, beforeRef);
  if (!file) return { ok: false, reason: 'file-not-found', error: `${config.dataFile} does not exist on branch "${beforeRef}".` };

  const format = config.format || 'js-export-array';
  let objRange = findObjectRange(file.content, idField, id, format);
  if (!objRange) {
    return { ok: false, reason: 'no-insertion-marker', error: `Could not find one unambiguous entry for ${idField} "${id}" in ${config.dataFile}.` };
  }
  if (config.nestedField) {
    objRange = resolveNestedObjectRange(file.content, objRange, config, nestedId);
    if (!objRange) {
      return { ok: false, reason: 'no-insertion-marker', error: `"${id}" has no "${config.nestedField}.${nestedId}" entry in ${config.dataFile} — this page has no unique content for that section yet.` };
    }
  }

  let content = file.content;
  const changedRegions = [];
  for (const [valueKey, fieldName] of Object.entries(config.fields)) {
    const newValue = values[valueKey];
    if (newValue == null) continue;
    const before = findScalarFieldRange(content, objRange, fieldName, format);
    if (!before) {
      return { ok: false, reason: 'no-insertion-marker', error: `Could not find a plain string "${fieldName}" field on the ${idField} "${id}" entry in ${config.dataFile} to update.` };
    }
    const beforeValue = content.slice(before.valueStart, before.valueEnd);
    const spliced = spliceScalarField(content, objRange, fieldName, newValue, format);
    // objRange's end shifts as the object's own content grows/shrinks with
    // each field written — start never moves (the object's own opening
    // brace, always before any field inside it).
    objRange = { start: objRange.start, end: objRange.end + (spliced.length - content.length) };
    content = spliced;
    changedRegions.push({ field: valueKey, markerName: fieldName, before: beforeValue, after: JSON.stringify(newValue) });
  }

  const check = assertValidContent(content, format);
  if (!check.ok) {
    return { ok: false, reason: 'invalid-edit', error: `Auto-generated edit would break ${config.dataFile}'s syntax (${check.error}) — refused to apply.` };
  }

  return { ok: true, filePath: config.dataFile, oldContent: file.content, newContent: content, changedRegions };
}

// `fetchFile` defaults to the real getFileContent — overridable only so
// tests can supply fixture content without a mocking library.
export async function computeChange(site, draft, fetchFile = getFileContent, beforeRef = baseBranch(site)) {
  const page = draft.content?.page || draft.input?.page;
  const config = resolveAdapter(site, page, draft.action_type);
  if (config?.fields) return computeScalarFieldChange(site, draft, fetchFile, beforeRef, config);
  const flatArray = config?.shape === 'flat-array';
  if (!config?.dataFile || (!flatArray && !config?.itemsField)) {
    return { ok: false, reason: 'no-file-mapping', error: `No data-array-content adapter config (dataFile/itemsField) found for "${page || '(no page)'}".` };
  }
  if (flatArray && config?.idField) {
    return { ok: false, reason: 'invalid-config', error: '"shape: flat-array" and "idField" are mutually exclusive — a flat array has no parent object to match by id.' };
  }
  const format = config.format || 'js-export-array';
  const itemsFieldLabel = config.itemsField || '(root array)';

  const validated = dedupeAndValidateFaqItems(draft.content?.items);
  if (!validated.ok) return { ok: false, reason: 'draft-not-ready', error: validated.error };

  const file = await fetchFile(site, config.dataFile, beforeRef);
  if (!file) return { ok: false, reason: 'file-not-found', error: `${config.dataFile} does not exist on branch "${beforeRef}".` };

  let arrayRange;
  let objRange = null;
  if (flatArray) {
    arrayRange = findRootArrayBounds(file.content, format);
    if (!arrayRange) {
      return { ok: false, reason: 'no-insertion-marker', error: `Could not find a top-level array in ${config.dataFile}.` };
    }
  } else {
    const idField = config.idField || 'id';
    const { id, nestedId } = config.nestedField ? nestedIdsFromPageUrl(page) : { id: idFromPageUrl(page), nestedId: null };
    if (!id || (config.nestedField && !nestedId)) return { ok: false, reason: 'no-file-mapping', error: `Could not derive ${config.nestedField ? 'a location + service id pair' : 'an id'} from "${page || '(no page)'}".` };

    objRange = findObjectRange(file.content, idField, id, format);
    if (!objRange) {
      return { ok: false, reason: 'no-insertion-marker', error: `Could not find one unambiguous entry for ${idField} "${id}" in ${config.dataFile}.` };
    }
    if (config.nestedField) {
      objRange = resolveNestedObjectRange(file.content, objRange, config, nestedId);
      if (!objRange) {
        return { ok: false, reason: 'no-insertion-marker', error: `"${id}" has no "${config.nestedField}.${nestedId}" entry in ${config.dataFile} — this page has no unique content for that section yet.` };
      }
    }
    arrayRange = findArrayFieldRange(file.content, objRange, config.itemsField, format);
  }

  const existingItems = arrayRange ? parseManagedFaqItems(file.content.slice(arrayRange.start, arrayRange.end), format) : [];
  const newContent = arrayRange
    ? spliceMarkedArray(file.content, arrayRange, validated.items, format)
    : insertNewArrayField(file.content, objRange, config.itemsField, validated.items, format);

  const check = assertValidContent(newContent, format);
  if (!check.ok) {
    return { ok: false, reason: 'invalid-edit', error: `Auto-generated edit would break ${config.dataFile}'s syntax (${check.error}) — refused to apply.` };
  }

  return {
    ok: true, filePath: config.dataFile, oldContent: file.content, newContent,
    changedRegions: [{ field: itemsFieldLabel, markerName: 'AI-managed', before: arrayRange ? '(previously AI-added items)' : '(none)', after: JSON.stringify(validated.items) }],
    faqDiff: diffFaqItems(existingItems, validated.items),
    // Always 'visible' — resolve.js's resolveImplementerForApply only ever
    // routes a 'faq' draft to this adapter once the real render-mode
    // decision (lib/faq-render-mode.js) has already come out 'visible';
    // 'schema-only' goes through the default marker-merge implementer
    // instead (see that module's own comment). Stamping it here is what lets
    // store/drafts.js's countVisibleFaqDrafts/hasImplementedVisibleFaqForPage
    // actually see this draft — without it, drafts written by this adapter
    // were invisible to both the sitewide visible-FAQ cap and the
    // cross-mechanism duplicate guard.
    renderMode: 'visible',
  };
}

export async function preview(site, draft) {
  const batchInfo = await getOrInitBatchBranch(site);
  if (batchInfo.conflicted) return batchBranchConflictError(site, batchInfo);
  const beforeRef = batchInfo.exists ? batchInfo.branchName : baseBranch(site);
  return computeChange(site, draft, getFileContent, beforeRef);
}

export async function apply(site, draft) {
  const batchInfo = await getOrInitBatchBranch(site);
  if (batchInfo.conflicted) return batchBranchConflictError(site, batchInfo);
  const beforeRef = batchInfo.exists ? batchInfo.branchName : baseBranch(site);
  const computed = await computeChange(site, draft, getFileContent, beforeRef);
  if (!computed.ok) return computed;
  return pushDraftBranch(site, draft, [{ path: computed.filePath, content: computed.newContent }], batchInfo);
}

export async function mergeToStage(site, draft) {
  const page = draft.content?.page || draft.input?.page;
  const config = resolveAdapter(site, page, draft.action_type);
  return openPrWithSnapshot(site, draft, config?.dataFile);
}

export async function rollback(site, draft) {
  const page = draft.content?.page || draft.input?.page;
  const config = resolveAdapter(site, page, draft.action_type);
  return rollbackFromSnapshot(site, draft, config?.dataFile, config?.format || 'js-export-array');
}
