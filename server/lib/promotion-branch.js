// A PROMOTION BRANCH: a fresh branch cut from the LATEST main that contains ONLY the changes a person (or the
// authorised staging agent) merged into stage and that were verified — nothing else that happens to be on stage.
//
// Why not just open stage -> main? Stage is a shared, moving branch. A PR from it carries everything on it: a batch that
// was merged but never verified, a change main has since overtaken, another team's work. The promotion PR is what a
// human reviews and approves for production, so it must contain exactly what was approved and verified, no more.
//
// How: for each approved stage PR, in the order merged, replay its file changes onto main's tip.
//   before  = the file just before the PR landed on stage   (the merge commit's first parent)
//   after   = the file as the PR left it                    (the merge commit)
//   current = the file now on the branch being built (main, plus the PRs already replayed)
//   current == after   -> already there, nothing to do
//   current == before  -> apply it
//   anything else      -> main has diverged on this file: the WHOLE PR is skipped, never half-applied, and reported
// A PR with a binary file is skipped too (the contents API round-trips text only). Skipped PRs are returned with the
// reason so the caller can tell a person exactly what needs a look; nothing is silently dropped.
//
// Nothing here merges anything. Every GitHub call is an injectable dependency, so it is tested with an in-memory repo.
import {
  getBranchSha, createBranch, commitFilesAtomic, getFileContent, listPullRequestFiles, getCommitParentSha,
} from '../github/client.js';

const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|pdf|zip|gz|tgz|woff2?|ttf|otf|eot|mp[34]|mov|webm|wasm|jar|exe|bin)$/i;

export async function buildPromotionBranch(site, { main, prs, branchName, message }, deps = {}) {
  const {
    readSha = getBranchSha, makeBranch = createBranch, commit = commitFilesAtomic,
    readFile = getFileContent, listFiles = listPullRequestFiles, parentOf = getCommitParentSha,
  } = deps;
  if (!main || !branchName || !Array.isArray(prs)) return { ok: false, reason: 'bad-input', error: 'main, branchName and prs are required.' };

  const mainSha = await readSha(site, main);
  const cache = new Map();
  const readAt = async (path, ref) => {
    const key = `${ref}\0${path}`;
    if (!cache.has(key)) { const f = await readFile(site, path, ref); cache.set(key, f ? f.content : null); }
    return cache.get(key);
  };

  const virtual = new Map(); // path -> content | null (deleted), what the branch will hold beyond main
  const applied = []; const skipped = [];
  const ordered = [...prs].sort((a, b) => String(a.mergedAt || '').localeCompare(String(b.mergedAt || '')) || a.number - b.number);

  for (const pr of ordered) {
    if (!pr.mergeSha) { skipped.push({ number: pr.number, reason: 'no-merge-commit', detail: 'GitHub reports no merge commit for it' }); continue; }
    // eslint-disable-next-line no-await-in-loop
    const files = await listFiles(site, pr.number);
    // eslint-disable-next-line no-await-in-loop
    const parent = await parentOf(site, pr.mergeSha);
    if (!parent) { skipped.push({ number: pr.number, reason: 'no-parent-commit', detail: 'could not find the state before it landed' }); continue; }

    const plan = []; let problem = null;
    for (const f of files) {
      if (BINARY.test(f.path) || (f.previousPath && BINARY.test(f.previousPath))) { problem = { reason: 'binary-file', detail: f.path }; break; }
      const ops = f.status === 'renamed' && f.previousPath
        ? [{ path: f.previousPath, remove: true }, { path: f.path, remove: false }]
        : [{ path: f.path, remove: f.status === 'removed' }];
      for (const op of ops) {
        // eslint-disable-next-line no-await-in-loop
        const before = await readAt(op.path, parent);
        // eslint-disable-next-line no-await-in-loop
        const after = op.remove ? null : await readAt(op.path, pr.mergeSha);
        // eslint-disable-next-line no-await-in-loop
        const current = virtual.has(op.path) ? virtual.get(op.path) : await readAt(op.path, mainSha);
        if (current === after) continue;
        if (current === before) { plan.push({ path: op.path, content: after, delete: after === null }); continue; }
        problem = { reason: 'main-changed', detail: op.path };
        break;
      }
      if (problem) break;
    }
    if (problem) { skipped.push({ number: pr.number, ...problem }); continue; }
    for (const op of plan) virtual.set(op.path, op.content);
    applied.push({ number: pr.number, title: pr.title ?? null, url: pr.url ?? null, files: plan.map((p) => p.path) });
  }

  if (virtual.size === 0) return { ok: true, noChange: true, branch: null, applied, skipped };
  const files = [...virtual].map(([path, content]) => (content === null ? { path, delete: true } : { path, content }));
  await makeBranch(site, branchName, mainSha);
  await commit(site, branchName, files, message || `Promote ${applied.length} verified change${applied.length === 1 ? '' : 's'} from stage`);
  return { ok: true, noChange: false, branch: branchName, baseSha: mainSha, applied, skipped, files: files.map((f) => f.path) };
}
