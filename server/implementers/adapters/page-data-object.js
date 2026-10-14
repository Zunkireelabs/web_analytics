import { getFileContent } from '../../github/client.js';
import { pushDraftBranch, getOrInitBatchBranch, baseBranch, batchBranchConflictError } from '../lib/github-ops.js';
import { resolveAdapter, resolveFile } from '../lib/url-file-map.js';
import {
  scanBalanced, findArrayFieldRange, spliceMarkedArray, parseManagedFaqItems,
  dedupeAndValidateFaqItems, diffFaqItems,
} from './lib/js-data-splice.js';
import { openPrWithSnapshot, rollbackFromSnapshot } from './lib/data-file-writer.js';

// A second Next.js App Router adapter, sibling to nextjs-metadata-export.js
// — for a different real shape found on the same repo (Admizz Education,
// confirmed 2026-09-11): a handful of pages (country/city landing pages —
// study-in-australia, birgunj, etc.) aren't authored as JSX body content at
// all. Each page.tsx builds one large local data object (e.g. `ausData`)
// and returns a single self-closing call into a shared template:
//   return <CountryPageTemplate data={ausData} blogPosts={blogPosts} />;
// structural-detect.js's detectJsxContainer correctly refuses these
// ('self-closing-root-no-body') — there is genuinely no JSX to insert
// markup into. But the real content isn't missing, it's just data-shaped:
// this adapter finds that SAME local object (by following the `data={...}`
// prop back to its `const <var> = {...}` declaration in the same file) and
// writes into its `faqItems` array field, reusing the exact array-splice
// primitives data-array-content.js already uses for shared _data files —
// same AI-managed-region-inside-the-array convention, so hand-authored FAQ
// items already on the page are never touched or reordered.
//
// Deliberately narrow, matching every other implementer here: only `faq`.
// `schema` has no equivalent — these templates render no JSON-LD today, and
// (per 2026-09-11 product decision) FAQPage schema for these pages is
// auto-derived from the same faqItems array by the template itself once
// wired, rather than drafted per page — see CountryPageTemplate.tsx /
// NepalVariantTemplate.tsx's own FAQPage <script> block. meta-title/
// canonical/open-graph already have a real Next.js adapter
// (nextjs-metadata-export.js) and are not handled here either.
//
// url_file_map config shape (patterns[].adapters.faq / pages[url].adapters.faq):
// just `{ "id": "page-data-object" }` — no per-site parameters, same as
// nextjs-metadata-export. Only ever applies where resolveFile() already
// resolves a real file (this adapter changes HOW the edit is made, not
// which file).

export const meta = {
  id: 'page-data-object',
  description: 'Writes faq items into a Next.js page\'s own local `const <var> = {...}` data object (the one passed as `data={...}` to a shared template component), for pages whose real content is data-shaped rather than JSX body content.',
};

const DATA_PROP_PATTERN = /<[A-Za-z][\w.]*\s+[^>]*\bdata=\{(\w+)\}/;

// Finds the `data={<var>}` prop passed to whichever component this page
// returns, then the byte range of that var's own `const <var> = {...}`
// object literal — same two-step "follow a reference, then bound its
// object" shape findMetadataObjectRange (nextjs-metadata-export.js) uses
// for `export const metadata`, just starting from a JSX prop instead of an
// export name.
function findPageDataObjectRange(content) {
  const propMatch = DATA_PROP_PATTERN.exec(content);
  if (!propMatch) return { range: null, varName: null, error: 'No JSX element in this file passes a `data={...}` prop to a template component.' };
  const varName = propMatch[1];

  const declPattern = new RegExp(`const\\s+${varName}\\s*(?::\\s*[\\w.<>[\\], ]+)?\\s*=\\s*\\{`);
  const declMatch = declPattern.exec(content);
  if (!declMatch) return { range: null, varName, error: `Found "data={${varName}}" but no local "const ${varName} = {...}" declaration in this file — it may be imported from elsewhere, which this adapter does not follow.` };

  const braceStart = declMatch.index + declMatch[0].length - 1;
  const end = scanBalanced(content, braceStart + 1, '{', '}');
  if (end === -1) return { range: null, varName, error: `Could not find the closing brace of "const ${varName} = {...}".` };
  return { range: { start: braceStart, end }, varName, error: null };
}

export async function computeChange(site, draft, fetchFile = getFileContent, beforeRef = baseBranch(site)) {
  if (draft.action_type !== 'faq') {
    return { ok: false, reason: 'invalid-config', error: `page-data-object does not support action type "${draft.action_type}" — only "faq" has an equivalent in a page's own data object.` };
  }

  const page = draft.content?.page || draft.input?.page;
  if (!page) return { ok: false, reason: 'draft-not-ready', error: 'Draft has no page URL' };

  const config = resolveAdapter(site, page, draft.action_type);
  if (!config) return { ok: false, reason: 'no-file-mapping', error: `No page-data-object adapter route configured for ${page} / ${draft.action_type}` };

  const filePath = resolveFile(site, page);
  if (!filePath) return { ok: false, reason: 'no-file-mapping', error: `No url_file_map file mapping for ${page}` };

  const validated = dedupeAndValidateFaqItems(draft.content?.items);
  if (!validated.ok) return { ok: false, reason: 'draft-not-ready', error: validated.error };

  const file = await fetchFile(site, filePath, beforeRef);
  if (!file) return { ok: false, reason: 'file-not-found', error: `${filePath} does not exist on branch "${beforeRef}".` };

  const { range: objRange, error: objError } = findPageDataObjectRange(file.content);
  if (!objRange) return { ok: false, reason: 'no-insertion-marker', error: `${filePath}: ${objError}` };

  const arrayRange = findArrayFieldRange(file.content, objRange, 'faqItems');
  if (!arrayRange) {
    return { ok: false, reason: 'no-insertion-marker', error: `${filePath}'s data object has no existing "faqItems" array for this adapter to write into — this page has no FAQ content yet, which needs a one-time human-authored starting point (never fabricated) before this can apply.` };
  }

  const existingItems = parseManagedFaqItems(file.content.slice(arrayRange.start, arrayRange.end));
  const newContent = spliceMarkedArray(file.content, arrayRange, validated.items);

  return {
    ok: true,
    filePath,
    oldContent: file.content,
    newContent,
    changedRegions: [{ field: 'faqItems', markerName: 'AI-managed', before: arrayRange ? '(previously AI-added items)' : '(none)', after: JSON.stringify(validated.items) }],
    faqDiff: diffFaqItems(existingItems, validated.items),
    // Same reasoning as data-array-content.js's own 'faq' path: this only
    // ever runs once render-mode has already resolved to 'visible', so the
    // sitewide visible-FAQ cap and cross-mechanism duplicate guard need to
    // see this draft the same way they see that adapter's writes.
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
  const filePath = resolveFile(site, page);
  return openPrWithSnapshot(site, draft, filePath);
}

export async function rollback(site, draft) {
  const page = draft.content?.page || draft.input?.page;
  const filePath = resolveFile(site, page);
  return rollbackFromSnapshot(site, draft, filePath);
}

export const __testables = { findPageDataObjectRange };
