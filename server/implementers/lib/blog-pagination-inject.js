import { getFileContent } from '../../github/client.js';
import { baseBranch, pushDraftBranch } from './github-ops.js';
import { detectConflictMarkers } from './conflict-marker-check.js';

// Applies a blog-pagination draft: rewrites the listing's source file(s) exactly as the generator planned them.
//
// draft.content.files = [{ path, before, after }]. Each file is written ONLY if its current content is byte-for-byte the `before` the draft
// was planned from (exact match or refuse, like every other rewriting implementer): a listing that changed since the draft was generated is
// refused, never merged over, so no one's edit can be silently lost. A file the recipe CREATES (a framework's page-2-and-up route) has
// `before: null`: it is written only if no file exists at that path yet, so nothing is ever overwritten.
const norm = (t) => String(t ?? '').replace(/\r\n/g, '\n');

function filesOf(draft) {
  const files = draft?.content?.files;
  if (!Array.isArray(files) || !files.length || files.some((f) => !f?.path || !(typeof f.before === 'string' || f.before === null) || typeof f.after !== 'string')) return null;
  return files;
}

export async function computeBlogPaginationMerge(site, draft, beforeRef = baseBranch(site), deps = {}) {
  const read = deps.getFileContent || getFileContent;
  const files = filesOf(draft);
  if (!files) return { ok: false, reason: 'draft-not-ready', error: 'This draft has no planned file changes (content.files), so there is nothing to apply.' };
  const out = [];
  for (const f of files) {
    const current = await read(site, f.path, beforeRef);
    if (f.before === null) {
      if (current) return { ok: false, reason: 'source-changed', error: `${f.path} now exists, but this draft planned to create it. It was not overwritten. Regenerate the draft.` };
      out.push({ path: f.path, oldContent: '', newContent: f.after });
      continue;
    }
    if (!current) return { ok: false, reason: 'file-not-found', error: `${f.path} does not exist on branch "${beforeRef}" — confirm the listing's mapping in url_file_map.` };
    const conflict = detectConflictMarkers(current.content);
    if (conflict) return conflict;
    if (norm(current.content) !== norm(f.before)) {
      return { ok: false, reason: 'source-changed', error: `${f.path} has changed since this draft was generated, so it was not overwritten. Regenerate the draft against the current file.` };
    }
    out.push({ path: f.path, oldContent: current.content, newContent: f.after });
  }
  const [first] = out;
  return {
    ok: true, filePath: first.path, oldContent: first.oldContent, newContent: first.newContent, files: out,
    changedRegions: out.map((f) => ({ field: 'blogPagination', markerName: f.path, before: f.oldContent === '' ? '(new file)' : `(the listing as it is now: ${f.path})`, after: f.oldContent === '' ? '(created)' : '(paginated)' })),
  };
}

export async function pushBlogPaginationBranch(site, draft, batchInfo, beforeRef = baseBranch(site), deps = {}) {
  const push = deps.pushDraftBranch || pushDraftBranch;
  const merged = await computeBlogPaginationMerge(site, draft, beforeRef, deps);
  if (!merged.ok) return merged;
  return push(site, draft, merged.files.map((f) => ({ path: f.path, content: f.newContent })), batchInfo);
}

// What is live now: the listing file as it stands, so a reviewer can see whether it is still the one the draft was planned from.
export async function previewLiveBlogPagination(site, draft, deps = {}) {
  const read = deps.getFileContent || getFileContent;
  const files = filesOf(draft);
  if (!files) return { ok: false, reason: 'draft-not-ready', error: 'This draft has no planned file changes.' };
  const current = await read(site, files[0].path, baseBranch(site));
  if (!current) return { ok: false, reason: 'file-not-found', error: `${files[0].path} does not exist on branch "${baseBranch(site)}".` };
  const stillPlanned = norm(current.content) === norm(files[0].before);
  const paginated = /^pagination\s*:/m.test(current.content);
  return { ok: true, filePath: files[0].path, live: true, changedRegions: [{ field: 'blogPagination', content: current.content, stillPlannedFrom: stillPlanned, alreadyPaginated: paginated }] };
}
