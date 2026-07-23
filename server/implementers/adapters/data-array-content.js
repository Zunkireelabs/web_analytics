import { getFileContent } from '../../github/client.js';
import { pushDraftBranch, getOrInitBatchBranch, STAGE_BRANCH } from '../lib/github-ops.js';
import { resolveAdapter } from '../lib/url-file-map.js';
import {
  findObjectRange, findArrayFieldRange, spliceMarkedArray, insertNewArrayField,
  assertValidContent, dedupeAndValidateFaqItems, diffFaqItems, parseManagedFaqItems,
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

// `fetchFile` defaults to the real getFileContent — overridable only so
// tests can supply fixture content without a mocking library.
export async function computeChange(site, draft, fetchFile = getFileContent, beforeRef = STAGE_BRANCH) {
  const page = draft.content?.page || draft.input?.page;
  const config = resolveAdapter(site, page, draft.action_type);
  if (!config?.dataFile || !config?.itemsField) {
    return { ok: false, reason: 'no-file-mapping', error: `No data-array-content adapter config (dataFile/itemsField) found for "${page || '(no page)'}".` };
  }
  const format = config.format || 'js-export-array';
  const idField = config.idField || 'id';

  const id = idFromPageUrl(page);
  if (!id) return { ok: false, reason: 'no-file-mapping', error: `Could not derive an id from "${page || '(no page)'}".` };

  const validated = dedupeAndValidateFaqItems(draft.content?.items);
  if (!validated.ok) return { ok: false, reason: 'draft-not-ready', error: validated.error };

  const file = await fetchFile(site, config.dataFile, beforeRef);
  if (!file) return { ok: false, reason: 'file-not-found', error: `${config.dataFile} does not exist on branch "${beforeRef}".` };

  const objRange = findObjectRange(file.content, idField, id, format);
  if (!objRange) {
    return { ok: false, reason: 'no-insertion-marker', error: `Could not find one unambiguous entry for ${idField} "${id}" in ${config.dataFile}.` };
  }

  const arrayRange = findArrayFieldRange(file.content, objRange, config.itemsField, format);
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
    changedRegions: [{ field: config.itemsField, markerName: 'AI-managed', before: arrayRange ? '(previously AI-added items)' : '(none)', after: JSON.stringify(validated.items) }],
    faqDiff: diffFaqItems(existingItems, validated.items),
  };
}

export async function preview(site, draft) {
  const batchInfo = await getOrInitBatchBranch(site);
  const beforeRef = batchInfo.exists ? batchInfo.branchName : STAGE_BRANCH;
  return computeChange(site, draft, getFileContent, beforeRef);
}

export async function apply(site, draft) {
  const batchInfo = await getOrInitBatchBranch(site);
  const beforeRef = batchInfo.exists ? batchInfo.branchName : STAGE_BRANCH;
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
