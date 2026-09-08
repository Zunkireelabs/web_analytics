import { getFileContent } from '../../github/client.js';
import { pushDraftBranch, getOrInitBatchBranch, baseBranch, batchBranchConflictError } from '../lib/github-ops.js';
import { resolveAdapter, resolveFile } from '../lib/url-file-map.js';
import {
  scanBalanced, findObjectFieldRange, findScalarFieldRange, spliceScalarField, insertNewScalarField,
} from './lib/js-data-splice.js';
import { openPrWithSnapshot, rollbackFromSnapshot } from './lib/data-file-writer.js';

// Next.js App Router execution adapter — the framework-native counterpart to
// marker-merge.js's HTML-comment splice, for meta-title/canonical/open-graph
// only.
//
// WHY THIS EXISTS: on a site built with Next.js's App Router, every
// page/layout file sets its own SEO fields via a literal, static
// `export const metadata: Metadata = {...}` object (Next's own convention —
// https://nextjs.org/docs/app/api-reference/functions/generate-metadata),
// which Next reads at build time to emit the real <title>/<meta>/<link>
// tags. There usually isn't even a literal `<head>...</head>` in most page
// files for marker-merge to splice into (only the root layout has one) —
// and even where there is, splicing raw `<meta property="og:...">` tags
// there would just create a SECOND, conflicting set alongside whatever Next
// already emits from the metadata export. Confirmed against Admizz
// Education's real repo (admizz-web-dev) 2026-09-08: every page file,
// Sanity-backed or plain, follows this exact pattern.
//
// Same string/comment-aware splice primitives as data-array-content.js's
// scalar-field path (js-data-splice.js) — this is not a new parsing
// strategy, just a new root-object finder (the `metadata` export instead of
// an id-matched array entry) plus one level of nesting for
// alternates.canonical / openGraph.{title,description}. No @babel/generator
// or similar is available in this codebase (only @babel/parser +
// @babel/traverse, used elsewhere purely to LOCATE positions, never to
// regenerate source) — regenerating a whole file from an AST would silently
// reformat/re-order a real client's source, which nothing else in this app
// does either. String splicing at verified byte offsets is the established,
// safer pattern here.
//
// url_file_map config shape (patterns[].adapters[actionType] or
// pages[url].adapters[actionType]): just `{ "id": "nextjs-metadata-export" }`
// — no per-site parameters needed. The file path comes from the SAME
// resolveFile() every other existing-page generator already uses (this
// adapter only changes HOW the edit is made, not which file), so it only
// ever applies to a page that already has a normal pages[]/patterns[] file
// mapping.
//
// Fields handled (intentionally narrow — only what a real Next.js Metadata
// object commonly has as a plain string, top-level or one level nested):
//   meta-title  -> title (top-level), description (top-level, optional)
//   canonical   -> alternates.canonical (requires an existing `alternates`
//                  object; this adapter never invents that object itself —
//                  see computeChange's no-insertion-marker case)
//   open-graph  -> openGraph.title, openGraph.description (requires an
//                  existing `openGraph` object, same reasoning)
// schema/faq/internal-links/expand-content/qa-content have no metadata-export
// equivalent at all and are not handled here — routing one of those action
// types to this adapter is a config mistake, refused below.

export const meta = {
  id: 'nextjs-metadata-export',
  description: 'Patches meta-title/canonical/open-graph fields directly inside a Next.js page\'s own `export const metadata` object, for App Router sites where marker-splice into raw HTML does not apply.',
};

const METADATA_EXPORT_PATTERN = /export\s+const\s+metadata\s*(?::\s*[\w.<>[\], ]+)?\s*=\s*\{/;

// Byte range of the `export const metadata = { ... }` object itself
// (inclusive of both braces, same convention as js-data-splice.js's other
// *Bounds/*Range helpers) — null if this file has no static metadata export
// at all (e.g. it uses `generateMetadata()` instead, or has none).
function findMetadataObjectRange(content) {
  const m = METADATA_EXPORT_PATTERN.exec(content);
  if (!m) return null;
  const braceStart = m.index + m[0].length - 1;
  const end = scanBalanced(content, braceStart + 1, '{', '}');
  if (end === -1) return null;
  return { start: braceStart, end };
}

// { valueKey: fieldName } per action type, scoped to the top-level metadata
// object — 'canonical'/'open-graph' resolve their own nested parent object
// first (see writeFields below) rather than living in this table, since
// findScalarFieldRange needs the NESTED object's range, not the root one.
const TOP_LEVEL_FIELDS_BY_ACTION_TYPE = {
  'meta-title': { selectedTitle: 'title', metaDescription: 'description' },
};

// { valueKey: fieldName }, and which top-level field holds the parent
// object these live inside.
const NESTED_FIELDS_BY_ACTION_TYPE = {
  canonical: { parentField: 'alternates', fields: { canonicalUrl: 'canonical' } },
  'open-graph': { parentField: 'openGraph', fields: { ogTitle: 'title', ogDescription: 'description' } },
};

function valuesFromDraft(actionType, content) {
  if (actionType === 'meta-title') {
    if (!content?.selectedTitle) {
      return { ok: false, error: 'No title has been selected for this draft yet — pick one of the title proposals first.' };
    }
    return { ok: true, values: { selectedTitle: content.selectedTitle, metaDescription: content.metaDescription || null } };
  }
  if (actionType === 'canonical') {
    if (!content?.canonicalUrl) return { ok: false, error: 'This canonical draft has no URL.' };
    return { ok: true, values: { canonicalUrl: content.canonicalUrl } };
  }
  if (actionType === 'open-graph') {
    if (!content?.ogTitle) return { ok: false, error: 'This Open Graph draft has no title.' };
    // Same refusal marker-merge.js's buildMergeValues applies for this
    // action type — a placeholder means the page had no real title/
    // description to draft from, so nothing here should ever publish it.
    if (content.placeholderFields?.length) {
      return { ok: false, error: `This Open Graph draft has ${content.placeholderFields.length} unverified placeholder field(s) (${content.placeholderFields.join(', ')}) — the page had no real title/description to draft from. Fill them in manually (edit the draft) before this can be applied.` };
    }
    return { ok: true, values: { ogTitle: content.ogTitle, ogDescription: content.ogDescription || null } };
  }
  return { ok: false, error: `nextjs-metadata-export has no field mapping for action type "${actionType}".` };
}

// Splices/inserts each configured field into `content` at `objRange`,
// re-deriving objRange's end after every write the same way
// computeScalarFieldChange (data-array-content.js) does, since each edit
// shifts the object's own byte length. Returns the updated content plus a
// diff list for the draft's own audit trail.
function writeFields(content, objRange, fieldMap, values) {
  const changedRegions = [];
  for (const [valueKey, fieldName] of Object.entries(fieldMap)) {
    const newValue = values[valueKey];
    if (newValue == null) continue;
    const before = findScalarFieldRange(content, objRange, fieldName);
    const beforeValue = before ? content.slice(before.valueStart, before.valueEnd) : '(none)';
    const spliced = before
      ? spliceScalarField(content, objRange, fieldName, newValue)
      : insertNewScalarField(content, objRange, fieldName, newValue);
    objRange = { start: objRange.start, end: objRange.end + (spliced.length - content.length) };
    content = spliced;
    changedRegions.push({ field: valueKey, targetField: fieldName, before: beforeValue, after: JSON.stringify(newValue) });
  }
  return { content, objRange, changedRegions };
}

export async function computeChange(site, draft, fetchFile = getFileContent, beforeRef = baseBranch(site)) {
  const page = draft.content?.page || draft.input?.page;
  if (!page) return { ok: false, reason: 'draft-not-ready', error: 'Draft has no page URL' };

  const config = resolveAdapter(site, page, draft.action_type);
  if (!config) return { ok: false, reason: 'no-file-mapping', error: `No nextjs-metadata-export adapter route configured for ${page} / ${draft.action_type}` };

  const filePath = resolveFile(site, page);
  if (!filePath) return { ok: false, reason: 'no-file-mapping', error: `No url_file_map file mapping for ${page}` };

  const topLevel = TOP_LEVEL_FIELDS_BY_ACTION_TYPE[draft.action_type];
  const nested = NESTED_FIELDS_BY_ACTION_TYPE[draft.action_type];
  if (!topLevel && !nested) {
    return { ok: false, reason: 'invalid-config', error: `nextjs-metadata-export does not support action type "${draft.action_type}".` };
  }

  const valuesResult = valuesFromDraft(draft.action_type, draft.content);
  if (!valuesResult.ok) return { ok: false, reason: 'draft-not-ready', error: valuesResult.error };
  const values = valuesResult.values;

  const file = await fetchFile(site, filePath, beforeRef);
  if (!file) return { ok: false, reason: 'file-not-found', error: `${filePath} does not exist on branch "${beforeRef}".` };

  let objRange = findMetadataObjectRange(file.content);
  if (!objRange) {
    return { ok: false, reason: 'no-insertion-marker', error: `Could not find a static "export const metadata = {...}" object in ${filePath} — this page may use generateMetadata() instead, which this adapter does not edit.` };
  }

  let content = file.content;
  let changedRegions = [];

  if (topLevel) {
    const written = writeFields(content, objRange, topLevel, values);
    content = written.content;
    objRange = written.objRange;
    changedRegions = changedRegions.concat(written.changedRegions);
  }

  if (nested) {
    const parentRange = findObjectFieldRange(content, objRange, nested.parentField);
    if (!parentRange) {
      return { ok: false, reason: 'no-insertion-marker', error: `${filePath}'s metadata object has no existing "${nested.parentField}" object for this adapter to write into — add one by hand once, the same one-time-anchor rule every other implementer here follows, before this can apply.` };
    }
    const written = writeFields(content, parentRange, nested.fields, values);
    content = written.content;
    changedRegions = changedRegions.concat(written.changedRegions);
  }

  if (!changedRegions.length) {
    return { ok: false, reason: 'draft-not-ready', error: 'This draft carries no field this adapter can write.' };
  }

  return { ok: true, filePath, newContent: content, changedRegions };
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
  const filePath = resolveFile(site, page);
  return openPrWithSnapshot(site, draft, filePath);
}

export async function rollback(site, draft) {
  const page = draft.content?.page || draft.input?.page;
  const filePath = resolveFile(site, page);
  return rollbackFromSnapshot(site, draft, filePath);
}

export const __testables = { findMetadataObjectRange, valuesFromDraft, writeFields };
