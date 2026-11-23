import { getFileContent } from '../../github/client.js';
import { pushDraftBranch, getOrInitBatchBranch, baseBranch, batchBranchConflictError } from '../lib/github-ops.js';
import { resolveAdapter } from '../lib/url-file-map.js';
import { keyFromPage, proveKey } from './ts-named-export-content.js';
import { locateRecordEntry, writeRecordFields, verifyRecordEdit } from './lib/ts-record-fields.js';
import { openPrWithSnapshot, rollbackFromSnapshot } from './lib/data-file-writer.js';

// Writes SEO fields into one entry of a named TypeScript record, for sites whose own convention keeps them there.
//
// WHY THIS EXISTS (admizz-web-dev, 2026-11-23): its blog posts are 177 JSON files rendered by ONE template, /[slug]/page.tsx, which uses `generateMetadata()`. The
// page-file adapter (nextjs-metadata-export) cannot edit that, so every meta-title draft for a post stopped with "no static metadata object", and the shared-template guard
// stopped the rest. The site already has a place for exactly this: src/data/post-seo-overrides.ts, keyed by post slug, read by the template ahead of the post's own SEO
// fields, and its header says wording fixes should ship there "in a PR, instead of editing the post file". 80 of the 177 posts already have an entry. This adapter writes there.
//
// Config (url_file_map.patterns[].adapters['meta-title'] or pages[url].adapters['meta-title']):
//   { id: 'ts-keyed-record-fields', dataFile: 'src/data/post-seo-overrides.ts', exportName: 'postSeoOverrides',
//     urlPattern: '^/([^/]+)/?$',                // capture group 1 IS the key
//     allowCreateKey: true,                       // may add an entry that is not in the file yet...
//     keyEvidence: { file: 'src/content/blog/posts/{key}.json' } }   // ...but ONLY when this proves the key is a real post
//     fields?: { selectedTitle: 'title', metaDescription: 'description' }   // draft value -> record field (this is the default for meta-title)
//
// Stops (returns { ok:false, reason, error }, writes nothing) whenever the target is not provably identified: no url match, file or export missing, export not a plain record, key
// duplicated, key absent without allowCreateKey, or the key not backed by keyEvidence. It never falls back to a shared template.
export const meta = {
  id: 'ts-keyed-record-fields',
  description: 'Writes meta-title fields (title, description) into one entry of a keyed TypeScript record such as post-seo-overrides.ts, verified by a no-execute byte-level safety proof.',
};

const DEFAULT_FIELDS = { 'meta-title': { selectedTitle: 'title', metaDescription: 'description' } };

function valuesFromDraft(actionType, content) {
  if (actionType === 'meta-title') {
    if (!content?.selectedTitle) return { ok: false, error: 'No title has been selected for this draft yet. Pick one of the title proposals first.' };
    return { ok: true, values: { selectedTitle: content.selectedTitle, metaDescription: content.metaDescription || null } };
  }
  return { ok: false, error: `ts-keyed-record-fields has no field mapping for action type "${actionType}".` };
}

function fieldMapFor(config, actionType) {
  return config?.fields && typeof config.fields === 'object' ? config.fields : DEFAULT_FIELDS[actionType] || null;
}

async function identify(site, page, config, actionType, fetchFile, ref) {
  if (!config?.dataFile || !config?.exportName) return { ok: false, reason: 'invalid-config', error: 'Adapter config needs dataFile and exportName.' };
  const fieldMap = fieldMapFor(config, actionType);
  if (!fieldMap) return { ok: false, reason: 'invalid-config', error: `ts-keyed-record-fields does not support action type "${actionType}".` };
  const k = keyFromPage(page, { ...config, shape: 'keyed-record' });
  if (!k.ok) return { ok: false, reason: 'no-file-mapping', error: k.error };
  const file = await fetchFile(site, config.dataFile, ref);
  if (!file) return { ok: false, reason: 'file-not-found', error: `${config.dataFile} does not exist on branch "${ref}".` };
  const located = locateRecordEntry(file.content, { exportName: config.exportName, key: k.key });
  if (!located.ok) return located;
  let create = false;
  if (!located.entry) {
    if (!config.allowCreateKey) return { ok: false, reason: 'target-not-identified', error: `"${k.key}" has no entry in ${config.exportName} and allowCreateKey is not set.` };
    const proof = await proveKey(site, config, k.key, fetchFile, ref);
    if (!proof.ok) return proof;
    create = true;
  }
  return { ok: true, key: k.key, file, located, create, fieldMap };
}

// Read-only: can this page's meta-title be written here? Same checks computeChange makes, minus the draft. Used by the pre-flight gate (agents/lib/recommendation-gates.js).
export async function isDataReady(site, page, config, fetchFile = getFileContent, ref = baseBranch(site), actionType = 'meta-title') {
  return (await identify(site, page, config, actionType, fetchFile, ref)).ok;
}

export async function computeChange(site, draft, fetchFile = getFileContent, ref = baseBranch(site)) {
  const page = draft.content?.page || draft.input?.page;
  if (!page) return { ok: false, reason: 'draft-not-ready', error: 'Draft has no page URL' };
  const config = resolveAdapter(site, page, draft.action_type);
  if (!config) return { ok: false, reason: 'no-file-mapping', error: `No ts-keyed-record-fields route configured for ${page} / ${draft.action_type}` };

  const id = await identify(site, page, config, draft.action_type, fetchFile, ref);
  if (!id.ok) return id;

  const valuesResult = valuesFromDraft(draft.action_type, draft.content);
  if (!valuesResult.ok) return { ok: false, reason: 'draft-not-ready', error: valuesResult.error };
  const fields = {};
  for (const [valueKey, field] of Object.entries(id.fieldMap)) fields[field] = valuesResult.values[valueKey] ?? null;

  const written = writeRecordFields(id.file.content, id.located, { key: id.key, fields, create: id.create });
  if (!written.ok) return written;

  const proof = verifyRecordEdit(id.file.content, written.content, { exportName: config.exportName, key: id.key, expected: written.after });
  if (!proof.ok) return { ok: false, reason: 'invalid-edit', error: `Safety check failed, nothing was written: ${proof.error}` };

  const changedRegions = Object.entries(fields).filter(([, v]) => v != null).map(([field, v]) => ({ field, before: written.before?.[field] ?? '(none)', after: v }));
  return { ok: true, filePath: config.dataFile, newContent: written.content, changedRegions, key: id.key, created: written.created };
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
  // A TypeScript data file cannot be executed to validate it; the snapshot is the verbatim file that was live right before the merge.
  return rollbackFromSnapshot(site, draft, config?.dataFile, 'ts-named-export');
}

export const __testables = { valuesFromDraft, fieldMapFor, identify };
