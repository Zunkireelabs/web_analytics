import { getFileContent } from '../../github/client.js';
import { analyzePageUrl } from '../../agents/lib/page-content.js';
import { pushDraftBranch, getOrInitBatchBranch, baseBranch, batchBranchConflictError } from '../lib/github-ops.js';
import { resolveAdapter } from '../lib/url-file-map.js';
import { buildMergeValues } from '../lib/marker-merge.js';
import {
  findObjectRange, findArrayFieldRange, findRootArrayBounds, spliceMarkedArray, insertNewArrayField,
  assertValidContent, dedupeAndValidateFaqItems, diffFaqItems, parseManagedFaqItems,
  findScalarFieldRange, spliceScalarField, insertNewScalarField, findObjectFieldRange, spliceObjectField, insertNewObjectField,
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

// Cheap, read-only readiness check: does this adapter's own data actually
// have the entry (or nested entry) this page needs, or would every draft
// for it be doomed to fail the same "has no ... entry" error computeChange/
// computeScalarFieldChange discover only at apply time? Exposed so
// agents/lib/recommendations.js's pre-flight filter (isPageMapped today
// only confirms a ROUTE exists, not that the routed adapter's DATA is
// actually there) can stop resurfacing a recommendation that can never
// succeed, instead of it reappearing every refresh until someone notices
// the same failed draft repeatedly. Reuses the exact same lookup helpers
// apply() itself uses — one evidence path, not a second guess at it.
export async function isDataReady(site, page, config, fetchFile = getFileContent, beforeRef = baseBranch(site)) {
  const idField = config.idField || 'id';
  const { id, nestedId } = config.nestedField ? nestedIdsFromPageUrl(page) : { id: idFromPageUrl(page), nestedId: null };
  if (!id || (config.nestedField && !nestedId)) return false;

  const file = await fetchFile(site, config.dataFile, beforeRef);
  if (!file) return false;

  const format = config.format || 'js-export-array';
  const objRange = findObjectRange(file.content, idField, id, format);
  if (!objRange) return false;
  if (config.nestedField) return !!resolveNestedObjectRange(file.content, objRange, config, nestedId);
  return true;
}

// The draft value keys this adapter knows how to write into a plain string
// field (config.fields), and where each one comes from. meta-title is kept
// as its own literal extraction (exact original behavior/error text,
// unchanged) since it's the long-established, already-live path. Every
// other type (internal-links, expand-content, qa-content, and any future
// one buildMergeValues grows) is delegated straight to marker-merge.js's
// buildMergeValues — the SAME rendering used for a per-file template's
// marker splice — so a pagination-generated page (no per-file template to
// marker-splice into) gets byte-identical rendered HTML written into its
// own data-array entry instead, using the site's own captured
// componentTemplates for visual parity, not a second, divergent renderer.
function scalarValuesFromDraft(actionType, content, componentTemplates, designProfile, page) {
  if (actionType === 'meta-title') {
    if (!content?.selectedTitle) {
      return { ok: false, error: 'No title has been selected for this draft yet — pick one of the title proposals first.' };
    }
    const values = { title: content.selectedTitle };
    if (content.metaDescription) values.metaDescription = content.metaDescription;
    return { ok: true, values };
  }
  return buildMergeValues(actionType, content || {}, 'visible', componentTemplates, designProfile, { page });
}

// Writes a draft's rendered value(s) into an existing object's own plain
// string field(s) (config.fields) — inserting the field if it doesn't exist
// yet on this entry (same "insert if missing, once; splice thereafter"
// posture computeSchemaFieldChange already uses for schemaField), never
// guessing WHICH field to use, only whether it already exists. A separate
// function from computeChange's FAQ/items array path below: different edit
// primitive (scalar splice/insert, not array splice), and a plain
// changedRegions diff with no FAQ-specific renderMode/faqDiff fields that
// would be meaningless here.
async function computeScalarFieldChange(site, draft, fetchFile, beforeRef, config) {
  const page = draft.content?.page || draft.input?.page;
  const componentTemplates = site?.url_file_map?.siteRoot?.componentTemplates || {};
  const designProfile = site?.url_file_map?.siteRoot?.designProfile || null;
  const valuesResult = scalarValuesFromDraft(draft.action_type, draft.content, componentTemplates, designProfile, page);
  if (!valuesResult.ok) {
    return { ok: false, reason: 'draft-not-ready', error: valuesResult.error };
  }
  const values = valuesResult.values;

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
    const beforeValue = before ? content.slice(before.valueStart, before.valueEnd) : '(none)';
    const spliced = before
      ? spliceScalarField(content, objRange, fieldName, newValue, format)
      : insertNewScalarField(content, objRange, fieldName, newValue, format);
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

// Writes a schema draft's JSON-LD onto an existing object's own field
// (config.schemaField) as a real object literal — the object counterpart to
// computeScalarFieldChange's string-field write above, for a schema.js
// draft targeting a data-driven page (a locations.js service entry, a
// comparisons.js entry) with no per-page template file of its own to
// marker-splice into. That's not an oversight — a marker splice targets a
// SHARED pagination template (see lib/url-file-map.js's resolveAdapter doc
// comment), so a naive splice there would apply one page's schema to every
// page using that template; writing into this specific entry's own field in
// the data array is the safe, real per-page equivalent, mirroring how
// `fields` above already does this for meta-title. The corresponding
// template (e.g. location-service.njk) must itself render this field as a
// JSON-LD script tag for the write to actually surface on the live page —
// this only writes the data half.
//
// Same "don't auto-publish an unverified guess" rule lib/marker-merge.js's
// buildMergeValues enforces for the marker-merge schema path applies here
// too: a draft with any unresolved placeholder field refuses, not just a
// missing jsonLd outright.
async function computeSchemaFieldChange(site, draft, fetchFile, beforeRef, config, analyzePage = analyzePageUrl) {
  const page = draft.content?.page || draft.input?.page;
  if (!draft.content?.jsonLd) {
    return { ok: false, reason: 'draft-not-ready', error: 'This schema draft has no JSON-LD to apply.' };
  }
  if (draft.content.placeholderFields?.length) {
    return {
      ok: false, reason: 'draft-not-ready',
      error: `This schema draft has ${draft.content.placeholderFields.length} unverified placeholder field(s) (${draft.content.placeholderFields.join(', ')}) — the model couldn't confirm these from the real page text. Fill them in manually (edit the draft) before this can be applied.`,
    };
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

  const fieldName = config.schemaField;
  const existingRange = findObjectFieldRange(file.content, objRange, fieldName, format);

  // Only a brand-new schemaField can create a NEW duplicate — splicing an
  // existing one just rewrites the same field this adapter already owns.
  // Re-check the real live page (not just this data file) for the type
  // we're about to insert: the type this entry needs may already be
  // rendered by the page's own template (e.g. a pagination template's
  // shared schema block), and this adapter has no other way to see that —
  // it only ever reads config.dataFile, never the rendered page. Same
  // guard/error shape as generators/schema.js's draft-time check; this is
  // the apply-time counterpart, for drafts created before that check
  // existed or against a page that changed since the draft was made.
  if (!existingRange) {
    const draftType = draft.content.jsonLd['@type'];
    const fetched = await analyzePage(page);
    if (fetched.ok && draftType && fetched.analysis.schemaTypes.includes(draftType)) {
      return {
        ok: false, reason: 'would-duplicate-schema',
        error: `This page already has real "${draftType}" schema — inserting another via ${fieldName} would duplicate it, not fix a gap.`,
      };
    }
  }

  const before = existingRange ? file.content.slice(existingRange.start, existingRange.end + 1) : '(none)';
  const newContent = existingRange
    ? spliceObjectField(file.content, objRange, fieldName, draft.content.jsonLd, format)
    : insertNewObjectField(file.content, objRange, fieldName, draft.content.jsonLd, format);

  const check = assertValidContent(newContent, format);
  if (!check.ok) {
    return { ok: false, reason: 'invalid-edit', error: `Auto-generated edit would break ${config.dataFile}'s syntax (${check.error}) — refused to apply.` };
  }

  return {
    ok: true, filePath: config.dataFile, oldContent: file.content, newContent,
    changedRegions: [{ field: 'schema', markerName: fieldName, before, after: JSON.stringify(draft.content.jsonLd) }],
  };
}

// `fetchFile` defaults to the real getFileContent — overridable only so
// tests can supply fixture content without a mocking library.
export async function computeChange(site, draft, fetchFile = getFileContent, beforeRef = baseBranch(site), analyzePage = analyzePageUrl) {
  const page = draft.content?.page || draft.input?.page;
  const config = resolveAdapter(site, page, draft.action_type);
  if (config?.schemaField) return computeSchemaFieldChange(site, draft, fetchFile, beforeRef, config, analyzePage);
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
