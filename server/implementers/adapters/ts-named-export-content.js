import { getFileContent } from '../../github/client.js';
import { pushDraftBranch, getOrInitBatchBranch, baseBranch, batchBranchConflictError } from '../lib/github-ops.js';
import { resolveAdapter } from '../lib/url-file-map.js';
import { dedupeAndValidateFaqItems, diffFaqItems, parseManagedFaqItems, parseExistingFaqItems } from './lib/js-data-splice.js';
import { locateTarget, writeItems, verifyDataEdit } from './lib/ts-export-data.js';
import { openPrWithSnapshot, rollbackFromSnapshot } from './lib/data-file-writer.js';

// Data-store writer for FAQ content that lives in a named TypeScript export, e.g. admizz-web-dev's
//   src/data/post-faqs.ts   export const postFaqs: Record<string, PostFaqItem[]> = { "<post-slug>": [...] }   (read by /[slug])
//   src/data/page-faqs.ts   export const categoryFaqs: Record<string, FAQItem[]> = { "<category>": [...] }       (read by /category/[slug])
//                           export const blogIndexFaqs: FAQItem[] = [...]                                        (read by /blogs)
// Faq only. data-array-content cannot serve these: its root-array finder wants `export default`, its validator executes the file with
// `new Function` (impossible for .ts), and it has no keyed-record shape.
//
// Config (url_file_map.patterns[].adapters.faq / pages[url].adapters.faq):
//   { id: 'ts-named-export-content', dataFile, exportName,
//     shape: 'keyed-record' | 'flat-array',
//     urlPattern: '^/category/([^/]+)/?$'        // keyed-record: capture group 1 IS the key. flat-array: matches the one page.
//     allowCreateKey?: true,                      // keyed-record only: may add a key that is not in the file yet...
//     keyEvidence?: { file: 'src/content/blog/posts/{key}.json', includes?: '"slug": "{key}"' } }  // ...but ONLY when this proves it
//
// Stops (returns { ok:false, reason, error }, writes nothing) whenever the target is not provably identified: no/ambiguous url match,
// file missing, export missing or declared twice, not a plain record, key duplicated, key absent without allowCreateKey, or the key
// is not backed by keyEvidence. It never falls back to a shared template.
export const meta = {
  id: 'ts-named-export-content',
  description: 'Writes faq items into a named TypeScript data export (keyed-record or flat-array), verified by a no-execute byte-level safety proof.',
};

export function keyFromPage(page, config) {
  let path;
  try { path = new URL(page).pathname; } catch { return { ok: false, error: `"${page}" is not a URL.` }; }
  if (!config?.urlPattern) return { ok: false, error: 'No urlPattern configured, so the page cannot be tied to an entry.' };
  let re;
  try { re = new RegExp(config.urlPattern); } catch { return { ok: false, error: `urlPattern "${config.urlPattern}" is not a valid regex.` }; }
  const m = re.exec(path.replace(/\/+$/, '') || '/') || re.exec(path);
  if (!m) return { ok: false, error: `${path} does not match urlPattern ${config.urlPattern}.` };
  if (config.shape === 'flat-array') return { ok: true, key: null };
  if (!m[1]) return { ok: false, error: 'urlPattern has no capture group for the key.' };
  return { ok: true, key: m[1] };
}

const sub = (s, key) => s.replaceAll('{key}', key);

export async function proveKey(site, config, key, fetchFile, ref) {
  const ev = config.keyEvidence;
  if (!ev?.file) return { ok: false, reason: 'target-not-identified', error: `"${key}" is not in ${config.dataFile} and no keyEvidence is configured to prove it is a real page — refusing to create it.` };
  const file = await fetchFile(site, sub(ev.file, key), ref);
  if (!file) return { ok: false, reason: 'target-not-identified', error: `No ${sub(ev.file, key)} on "${ref}" — "${key}" is not a known page, refusing to create an entry for it.` };
  if (ev.includes && !String(file.content).includes(sub(ev.includes, key))) return { ok: false, reason: 'target-not-identified', error: `${sub(ev.file, key)} does not contain ${sub(ev.includes, key)} — "${key}" is not proven to be a page.` };
  return { ok: true };
}

// Read-only: can this page's FAQ be written here? Same checks computeChange makes, minus the draft. Used by the pre-flight gate and
// the production audit, so there is one definition of "identified".
export async function isDataReady(site, page, config, fetchFile = getFileContent, ref = baseBranch(site)) {
  return (await identifyTarget(site, page, config, fetchFile, ref)).ok;
}

export async function identifyTarget(site, page, config, fetchFile = getFileContent, ref = baseBranch(site)) {
  if (!config?.dataFile || !config?.exportName || !['keyed-record', 'flat-array'].includes(config.shape)) {
    return { ok: false, reason: 'invalid-config', error: 'Adapter config needs dataFile, exportName and shape ("keyed-record" | "flat-array").' };
  }
  const k = keyFromPage(page, config);
  if (!k.ok) return { ok: false, reason: 'no-file-mapping', error: k.error };
  const file = await fetchFile(site, config.dataFile, ref);
  if (!file) return { ok: false, reason: 'file-not-found', error: `${config.dataFile} does not exist on branch "${ref}".` };
  const target = locateTarget(file.content, { exportName: config.exportName, shape: config.shape, key: k.key });
  if (!target.ok) return target;
  let create = false;
  if (target.absent) {
    if (!config.allowCreateKey) return { ok: false, reason: 'target-not-identified', error: `"${k.key}" has no entry in ${config.exportName} and allowCreateKey is not set.` };
    const proof = await proveKey(site, config, k.key, fetchFile, ref);
    if (!proof.ok) return proof;
    create = true;
  }
  return { ok: true, file, target, key: k.key, create };
}

export async function computeChange(site, draft, fetchFile = getFileContent, ref = baseBranch(site)) {
  const page = draft.content?.page || draft.input?.page;
  if (draft.action_type !== 'faq') return { ok: false, reason: 'unsupported-action', error: `ts-named-export-content only writes faq drafts, not "${draft.action_type}".` };
  const config = resolveAdapter(site, page, draft.action_type);
  if (config?.id !== meta.id) return { ok: false, reason: 'no-file-mapping', error: `No ${meta.id} config resolves for "${page || '(no page)'}".` };

  const validated = dedupeAndValidateFaqItems(draft.content?.items);
  if (!validated.ok) return { ok: false, reason: 'draft-not-ready', error: validated.error };

  const id = await identifyTarget(site, page, config, fetchFile, ref);
  if (!id.ok) return id;
  const { file, target, key, create } = id;

  // Never duplicate a question a human already wrote under the same key (previously managed items are replaced, so not counted).
  let items = validated.items;
  if (target.arrayRange) {
    const interior = file.content.slice(target.arrayRange.start, target.arrayRange.end);
    const managed = new Set(parseManagedFaqItems(interior, 'js-export-array').map((x) => x.question.trim().toLowerCase()));
    const hand = new Set(parseExistingFaqItems(interior, 'js-export-array').map((x) => x.question.trim().toLowerCase()).filter((q) => !managed.has(q)));
    items = items.filter((x) => !hand.has(x.question.trim().toLowerCase()));
    if (!items.length) return { ok: false, reason: 'already-satisfied', error: `Every proposed question already exists, hand-written, under "${key ?? config.exportName}" — nothing to add.` };
  }

  const w = writeItems(file.content, target, { exportName: config.exportName, shape: config.shape, key, items, create });
  if (!w.ok) return w;
  const newContent = w.content;
  const priorManaged = w.priorManaged;

  const proof = verifyDataEdit(file.content, newContent, { exportName: config.exportName, shape: config.shape, key, newItems: items, priorManaged });
  if (!proof.ok) return { ok: false, reason: 'invalid-edit', error: `Edit to ${config.dataFile} failed the safety proof (${proof.error}) — refused to apply.` };

  return {
    ok: true, filePath: config.dataFile, oldContent: file.content, newContent,
    changedRegions: [{ field: `${config.exportName}${key ? `["${key}"]` : ''}`, markerName: 'AI-managed', before: priorManaged.length ? '(previously AI-added items)' : '(none)', after: JSON.stringify(items) }],
    faqDiff: diffFaqItems(priorManaged, items),
    createdKey: create ? key : null,
    // resolve.js only routes a faq draft here once the render mode is 'visible' (same contract as data-array-content).
    renderMode: 'visible',
  };
}

export async function preview(site, draft) {
  const batchInfo = await getOrInitBatchBranch(site);
  if (batchInfo.conflicted) return batchBranchConflictError(site, batchInfo);
  return computeChange(site, draft, getFileContent, batchInfo.exists ? batchInfo.branchName : baseBranch(site));
}

export async function apply(site, draft) {
  const batchInfo = await getOrInitBatchBranch(site);
  if (batchInfo.conflicted) return batchBranchConflictError(site, batchInfo);
  const computed = await computeChange(site, draft, getFileContent, batchInfo.exists ? batchInfo.branchName : baseBranch(site));
  if (!computed.ok) return computed;
  return pushDraftBranch(site, draft, [{ path: computed.filePath, content: computed.newContent }], batchInfo);
}

export async function mergeToStage(site, draft) {
  const page = draft.content?.page || draft.input?.page;
  return openPrWithSnapshot(site, draft, resolveAdapter(site, page, draft.action_type)?.dataFile);
}

export async function rollback(site, draft) {
  const page = draft.content?.page || draft.input?.page;
  return rollbackFromSnapshot(site, draft, resolveAdapter(site, page, draft.action_type)?.dataFile, 'ts-named-export');
}
